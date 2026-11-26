import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createService } from './helpers/licensed-service.js';
import { relationalTestDatabase } from './helpers/relational-database.js';
import { createApi } from '../http.js';
import { migrate } from '../database.js';
import { verifyMemberTotals } from '../../tests/helpers/member-totals.mjs';
import { verifyLowBalanceBoundaries } from '../../tests/helpers/low-balance-boundaries.mjs';

let database, pool, service, ledger, identity, accessToken, server, origin;
const password = 'Relational-Test-2026!';
const input = () => ({ ledgerEpoch: identity.ledgerEpoch, batchId: 'opening-batch-20261119', sourceDigest: 'a'.repeat(64), expectedCount: 91,
  members: Array.from({ length: 91 }, (_, index) => ({ id: 'member-' + index, name: '合成会员' + index, phone: index % 3 ? '001-000' : '',
    tags: ['测试'], notes: '', balanceCents: index === 0 ? '-1010' : index === 1 ? '0' : String(index * 100) })) });
async function command(memberId, type = 'recharge', extra = {}) {
  const member = await ledger.getMember(identity, memberId);
  return ledger.executeCommand(identity, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type, memberId, expectedAccountVersion: member.accountVersion,
    ...(type === 'recharge' ? { actualPayCents: '100', giftCents: '10' } : type === 'consume' ? { amountCents: '100' } : {}), ...extra });
}
async function count(table) { return Number((await pool.query('SELECT count(*) AS n FROM ' + table)).rows[0].n); }
before(async () => {
  database = await relationalTestDatabase(); pool = database.pool; console.log('v2 database engine:', database.engine, database.version);
  service = createService(pool); ledger = service.relational; server = createApi({ service, pool });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await database?.close(); });
beforeEach(async () => {
  await pool.query('TRUNCATE stores,login_limits RESTART IDENTITY CASCADE');
  const owner = await service.createOwner({ username: 'relational-owner', password });

  const session = await service.login({ username: 'relational-owner', password, deviceId: randomUUID() }, '127.0.0.1');
  accessToken = session.accessToken; identity = await service.authenticate(accessToken); identity.ledgerEpoch = (await ledger.getBook(identity)).ledgerEpoch;
});

test('server inclusive low-balance list equals zero plus the positive-low report band at every cent boundary', async () => {
  await verifyLowBalanceBoundaries({
    importMembers: data => ledger.importOpeningBalances(identity, { ...data, ledgerEpoch: identity.ledgerEpoch }),
    list: input => ledger.listMembers(identity, input),
    report: input => ledger.reportBusiness(identity, input)
  });
});

test('PostgreSQL member totals preserve full lifetime precision and serve a scoped HTTP aggregate', async () => {
  const book = await ledger.getBook(identity);
  const result = await verifyMemberTotals({
    create: data => ledger.createMember(identity, data, { ...book, id: randomUUID() }),
    command: (memberId, type, data) => command(memberId, type, data),
    totals: id => ledger.getMemberTotals(identity, id, book),
    history: memberId => ledger.listLedger(identity, { memberId, limit: 15 })
  });
  const route = origin + '/api/v2/members/' + result.member.id + '/totals?ledgerEpoch=' + book.ledgerEpoch;
  assert.equal((await fetch(route)).status, 401);
  const response = await fetch(route, { headers: { Authorization: 'Bearer ' + accessToken } });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), result.expected);
  await assert.rejects(ledger.getMemberTotals(identity, 'missing-member', book), { status: 404 });
  await assert.rejects(ledger.getMemberTotals(identity, result.member.id, { ledgerEpoch: randomUUID() }), { code: 'LEDGER_EPOCH_MISMATCH' });
  await pool.query('UPDATE store_licenses SET features=$1::jsonb WHERE store_id=$2', [JSON.stringify(['core', 'members', 'cashier']), book.storeId]);
  assert.deepEqual(await ledger.getMemberTotals(identity, result.member.id, book), result.expected);
  await pool.query('UPDATE store_licenses SET features=$1::jsonb WHERE store_id=$2', [JSON.stringify(['core', 'members']), book.storeId]);
  await assert.rejects(ledger.getMemberTotals(identity, result.member.id, book), { code: 'FEATURE_DISABLED' });
});

test('recent consumers exclude reversed and never-consumed profiles and return actual timestamps and scoped counts', async () => {
  await ledger.importOpeningBalances(identity, input());
  await command('member-2', 'consume'); const second = await command('member-3', 'consume');
  let recent = await ledger.listMembers(identity, { balance: 'recent' });
  assert.equal(recent.total, 2); assert.deepEqual(new Set(recent.items.map(row => row.id)), new Set(['member-2', 'member-3']));
  const last = (await ledger.getMember(identity, 'member-2')).lastConsumeAt;
  assert.ok(last); await ledger.updateMember(identity, 'member-2', { name: '改档案不算来店', expectedVersion: '0' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
  assert.equal((await ledger.getMember(identity, 'member-2')).lastConsumeAt, last);
  await command('member-3', 'reverse', { originalEntryId: second.entryId, reason: '回归冲正' });
  assert.equal((await ledger.getMember(identity, 'member-3')).lastConsumeAt, null);
  assert.equal((await ledger.listMembers(identity, { balance: 'recent' })).items.length, 1);
  for (let i = 4; i < 18; i++) await command('member-' + i, 'consume');
  recent = await ledger.listMembers(identity, { balance: 'recent', limit: 100 });
  assert.equal(recent.items.length, 12); assert.equal(recent.total, 15); assert.equal(recent.rangeLimit, 12); assert.equal(recent.nextCursor, null);
  assert.equal((await ledger.listMembers(identity, { limit: 1 })).total, 91);
  assert.equal((await ledger.listMembers(identity, { limit: 1, search: '合成会员1' })).total, 11);
});

test('server book generations fence restored requests before receipts, versions or opening idempotency', async () => {
  const source = input(); await ledger.importOpeningBalances(identity, source);
  const request = { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'recharge', memberId: 'member-1', expectedAccountVersion: '0', actualPayCents: '100', payments: [{ method: '现金', amountCents: '50' }, { method: '微信', amountCents: '50' }] };
  const receipt = await ledger.executeCommand(identity, request); assert.equal(receipt.ledgerEpoch, identity.ledgerEpoch);
  const task = { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'member.create', data: { name: '代际来源' } };
  await ledger.executeTask(identity, task);
  await command('member-2');
  const cursor = (await ledger.listMembers(identity, { limit: 1 })).nextCursor, historyCursor = (await ledger.listLedger(identity, { limit: 1 })).nextCursor;
  const reportQuery = { from: '2000-01-01T00:00:00.000Z', to: '9999-01-01T00:00:00.000Z', kind: 'payment', limit: 1 }, reportCursor = (await ledger.reportBreakdown(identity, reportQuery)).nextCursor;
  assert.ok(historyCursor); assert.ok(reportCursor);
  const oldBook = await ledger.getBook(identity), newEpoch = randomUUID();
  await pool.query('UPDATE stores SET ledger_epoch=$1 WHERE id=$2', [newEpoch, identity.store_id]);
  const newBook = await ledger.getBook(identity); assert.deepEqual(newBook, { storeId: identity.store_id, ledgerEpoch: newEpoch });
  for (const input of [request, { ...request, id: randomUUID(), expectedAccountVersion: '1' }, { ...request, ledgerEpoch: newEpoch }]) await assert.rejects(ledger.executeCommand(identity, input), { code: 'LEDGER_EPOCH_MISMATCH' });
  for (const input of [task, { ...task, id: randomUUID() }, { ...task, ledgerEpoch: newEpoch }]) await assert.rejects(ledger.executeTask(identity, input), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(ledger.getCommand(identity, request.id, oldBook), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(ledger.getCommand(identity, request.id, newBook), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(ledger.getTask(identity, task.id, newBook), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(ledger.changes(identity, { ...oldBook, after: '0' }), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(ledger.listMembers(identity, { cursor }), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(ledger.listLedger(identity, { cursor: historyCursor }), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(ledger.reportBreakdown(identity, { ...reportQuery, cursor: reportCursor }), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(ledger.previewOpeningImport(identity, source), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(ledger.importOpeningBalances(identity, source), { code: 'LEDGER_EPOCH_MISMATCH' });
  assert.equal(await count('ledger_entries'), 2); assert.equal(await count('application_task_receipts'), 1);
  assert.equal((await ledger.getMember(identity, 'member-1')).balanceCents, '100');
  const accepted = await ledger.executeCommand(identity, { ...request, ledgerEpoch: newEpoch, id: randomUUID(), expectedAccountVersion: '1' });
  assert.equal(accepted.ledgerEpoch, newEpoch); assert.equal(accepted.balanceAfterCents, '200');
});

test('HTTP book handshake requires authentication and stale or absent generation cannot write or resume', async () => {
  assert.equal((await fetch(origin + '/api/v2/book')).status, 401);
  const headers = { authorization: 'Bearer ' + accessToken, 'content-type': 'application/json' };
  const handshake = await fetch(origin + '/api/v2/book', { headers }); assert.equal(handshake.status, 200); assert.deepEqual(await handshake.json(), { storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
  const task = { id: randomUUID(), storeId: identity.store_id, type: 'member.create', data: { name: '过期任务' } };
  for (const [body, status, code] of [[task, 400, 'LEDGER_EPOCH_REQUIRED'], [{ ...task, ledgerEpoch: randomUUID() }, 409, 'LEDGER_EPOCH_MISMATCH']]) {
    const response = await fetch(origin + '/api/v2/tasks', { method: 'POST', headers, body: JSON.stringify(body) }); assert.equal(response.status, status); assert.equal((await response.json()).code, code);
  }
  assert.equal(await count('member_profiles'), 0);
  const sync = await fetch(origin + '/api/v2/sync/changes?ledgerEpoch=' + randomUUID(), { headers }); assert.equal(sync.status, 409);
  const recovery = await fetch(origin + '/api/v2/tasks/' + task.id, { headers }); assert.equal(recovery.status, 400);
});

test('pre-epoch development migration preserves funds and unlabelled receipts without rebinding them to a new book', async t => {
  const isolated = await relationalTestDatabase(); t.after(() => isolated.close());
  const service = createService(isolated.pool), ledger = service.relational, owner = await service.createOwner({ username: 'pre-epoch-owner', password });

  const login = await service.login({ username: 'pre-epoch-owner', password, deviceId: randomUUID() }, '127.0.0.1'), actor = await service.authenticate(login.accessToken), book = await ledger.getBook(actor);
  const task = { ...book, id: randomUUID(), type: 'member.create', data: { name: '保留开发数据' } }, member = await ledger.executeTask(actor, task);
  const request = { ...book, id: randomUUID(), type: 'recharge', memberId: member.id, expectedAccountVersion: '0', actualPayCents: '100' }; await ledger.executeCommand(actor, request);
  await isolated.pool.query("UPDATE ledger_command_receipts SET result=result-'ledgerEpoch'");
  await isolated.pool.query('ALTER TABLE ledger_command_receipts DROP COLUMN ledger_epoch');
  await isolated.pool.query('ALTER TABLE application_task_receipts DROP COLUMN ledger_epoch');
  await isolated.pool.query('ALTER TABLE stores DROP COLUMN ledger_epoch');
  await migrate(isolated.pool); const current = await ledger.getBook(actor); assert.notEqual(current.ledgerEpoch, book.ledgerEpoch);
  await migrate(isolated.pool); assert.deepEqual(await ledger.getBook(actor), current);
  assert.equal((await ledger.getMember(actor, member.id)).balanceCents, '100');
  assert.equal((await isolated.pool.query('SELECT ledger_epoch FROM ledger_command_receipts')).rows[0].ledger_epoch, null);
  assert.equal((await isolated.pool.query('SELECT ledger_epoch FROM application_task_receipts')).rows[0].ledger_epoch, null);
  for (const scope of [book, current]) {
    await assert.rejects(ledger.getCommand(actor, request.id, scope), { code: 'LEDGER_EPOCH_MISMATCH' });
    await assert.rejects(ledger.getTask(actor, task.id, scope), { code: 'LEDGER_EPOCH_MISMATCH' });
    await assert.rejects(ledger.executeCommand(actor, { ...request, ...scope }), { code: 'LEDGER_EPOCH_MISMATCH' });
    await assert.rejects(ledger.executeTask(actor, { ...task, ...scope }), { code: 'LEDGER_EPOCH_MISMATCH' });
  }
  const saved = await ledger.executeCommand(actor, { ...request, ...current, id: randomUUID(), expectedAccountVersion: '1' }); assert.equal(saved.balanceAfterCents, '200');
});

test('91 synthetic openings are atomic, exact, separate from revenue and individually readable', async () => {
  const source = input(), preview = await ledger.previewOpeningImport(identity, source);
  assert.equal(preview.memberCount, 91); assert.equal(preview.zeroBalanceCount, 1); assert.equal(preview.negativeBalanceCount, 1);
  assert.equal(preview.netBalanceCents, String(source.members.reduce((n, m) => n + BigInt(m.balanceCents), 0n)));
  await assert.rejects(ledger.importOpeningBalances(identity, { ...source, storeId: randomUUID() }), { code: 'OPENING_CONTEXT_CHANGED' });
  await assert.rejects(ledger.importOpeningBalances(identity, { ...source, payloadDigest: '0'.repeat(64) }), { code: 'OPENING_REVIEW_MISMATCH' });
  assert.equal(await count('account_opening_batches'), 0);
  const saved = await ledger.importOpeningBalances(identity, { ...source, storeId: identity.store_id, actorId: identity.id, deviceId: identity.device_id, payloadDigest: preview.payloadDigest });
  assert.equal(saved.payloadDigest, preview.payloadDigest);
  assert.equal(saved.alreadyImported, false); assert.equal(await count('member_profiles'), 91);
  assert.equal(await count('account_openings'), 91); assert.equal(await count('ledger_entries'), 0);
  for (const row of source.members) { const member = await ledger.getMember(identity, row.id); assert.equal(member.balanceCents, row.balanceCents); assert.equal(member.phone, row.phone); }
  const report = await ledger.report(identity, { from: '2020-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' });
  assert.equal(report.entryCount, 0); assert.equal(report.actualPayCents, '0'); assert.equal(report.debtCents, '-1010');
});

test('opening import rejects missing/extra rows, duplicate IDs, invalid money and changed content behind the same digest', async () => {
  for (const change of [v => v.members.pop(), v => v.members.push(v.members[0]), v => { v.members[1].id = v.members[0].id; },
    v => { v.members[1].balanceCents = ''; }, v => { v.members[1].balanceCents = '1e2'; }, v => { v.members[1].balanceCents = 100; },
    v => { v.members[1].balanceCents = '9223372036854775808'; }]) {
    const source = input(); change(source); await assert.rejects(ledger.importOpeningBalances(identity, source), error => error.status === 400 || error.status === 413);
    assert.equal(await count('member_profiles'), 0); assert.equal(await count('account_opening_batches'), 0);
  }
  const source = input(); await ledger.importOpeningBalances(identity, source); source.members[3].balanceCents = '1';
  await assert.rejects(ledger.importOpeningBalances(identity, source), { code: 'OPENING_BATCH_CONFLICT' });
});

test('100 opening retries return the original batch and new-source import cannot overwrite business', async () => {
  const source = input(); await ledger.importOpeningBalances(identity, source);
  for (let i = 0; i < 100; i++) assert.equal((await ledger.importOpeningBalances(identity, source)).alreadyImported, true);
  assert.equal(await count('member_profiles'), 91); assert.equal(await count('account_openings'), 91);
  await command('member-1');
  assert.equal((await ledger.importOpeningBalances(identity, source)).alreadyImported, true);
  assert.equal((await ledger.getMember(identity, 'member-1')).balanceCents, '110');
  await assert.rejects(ledger.importOpeningBalances(identity, { ...source, batchId: randomUUID(), sourceDigest: 'b'.repeat(64) }), { code: 'OPENING_NOT_EMPTY' });
});

test('commands are exact, immutable, idempotent and require the current account version', async () => {
  const member = await ledger.createMember(identity, { name: '测试会员' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
  const request = { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'recharge', memberId: member.id, expectedAccountVersion: '0', actualPayCents: '1010', giftCents: '101' };
  const result = await ledger.executeCommand(identity, request); assert.equal(result.balanceAfterCents, '1111'); assert.equal(result.accountVersion, '1');
  assert.deepEqual(await ledger.executeCommand(identity, request), result);
  assert.deepEqual(await ledger.getCommand(identity, request.id, { ledgerEpoch: identity.ledgerEpoch }), result);
  await assert.rejects(ledger.executeCommand(identity, { ...request, actualPayCents: '9' }), { code: 'COMMAND_CONFLICT' });
  await assert.rejects(ledger.executeCommand(identity, { ...request, id: randomUUID() }), { code: 'ACCOUNT_VERSION_CHANGED' });
  const consumed = await command(member.id, 'consume', { amountCents: '1112', allowDebt: true }); assert.equal(consumed.balanceAfterCents, '-1');
  assert.equal((await command(member.id)).balanceAfterCents, '109');
  assert.equal(await count('ledger_entries'), 3); assert.equal(await count('ledger_command_receipts'), 3);
});

test('reversal is linked once, preserves the original and requires fresh owner authorization and debt consent', async () => {
  const member = await ledger.createMember(identity, { name: '冲正测试' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch }); const charge = await command(member.id); await command(member.id, 'consume');
  const reversal = { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'reverse', memberId: member.id, expectedAccountVersion: '2', originalEntryId: charge.entryId };
  await assert.rejects(ledger.executeCommand(identity, reversal), /欠款/);
  await ledger.executeCommand(identity, { ...reversal, allowDebt: true });
  await assert.rejects(ledger.executeCommand(identity, { ...reversal, id: randomUUID(), expectedAccountVersion: '3', allowDebt: true }), { code: 'ALREADY_REVERSED' });
  assert.equal(await count('ledger_reversals'), 1);
  const rows = (await ledger.listLedger(identity, { memberId: member.id })).items;
  assert.equal(rows.find(row => row.id === charge.entryId).deltaCents, '110'); assert.equal(rows.find(row => row.id === charge.entryId).reversed, true);
  await pool.query("UPDATE users SET role='viewer' WHERE id=$1", [identity.id]);
  await assert.rejects(command(member.id), { status: 403 });
});

test('duplicate and stale-account concurrent calls have one financial effect; distinct accounts do not conflict', async () => {
  const a = await ledger.createMember(identity, { name: 'A' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch }), b = await ledger.createMember(identity, { name: 'B' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
  const request = { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'recharge', memberId: a.id, expectedAccountVersion: '0', actualPayCents: '1' };
  const duplicates = await Promise.all(Array.from({ length: 100 }, () => ledger.executeCommand(identity, request)));
  assert.equal(new Set(duplicates.map(result => result.entryId)).size, 1); assert.equal(await count('ledger_entries'), 1);
  const competing = await Promise.allSettled(Array.from({ length: 50 }, () => ledger.executeCommand(identity, { ...request, id: randomUUID(), expectedAccountVersion: '1' })));
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(competing.filter(result => result.status === 'rejected').every(result => result.reason.code === 'ACCOUNT_VERSION_CHANGED'));
  await Promise.all([command(a.id), command(b.id)]); assert.equal(await count('ledger_entries'), 4);
});

test('archived reversal rejects a reused phone and restores the original member exactly once', async () => {
  const book = await ledger.getBook(identity), task = () => ({ ...book, id: randomUUID() });
  const archived = await ledger.createMember(identity, { name: '原会员', phone: '+01 (234)' }, task());
  await assert.rejects(ledger.createMember(identity, { name: '号码冲突', phone: '01234' }, task()), { code: 'MEMBER_PHONE_IN_USE' });
  const topUp = await command(archived.id, 'recharge', { actualPayCents: '100', giftCents: '0' });
  const spent = await command(archived.id, 'consume');
  await ledger.archiveMember(identity, archived.id, task());
  const reused = await ledger.createMember(identity, { name: '另一会员', phone: '01234' }, task());
  const undo = { ...book, id: randomUUID(), type: 'reverse', memberId: archived.id, originalEntryId: spent.entryId, expectedAccountVersion: '2' };
  await assert.rejects(ledger.executeCommand(identity, undo), { code: 'MEMBER_PHONE_IN_USE' });
  assert.equal(await count('ledger_entries'), 2);
  assert.equal((await ledger.getMember(identity, archived.id)).balanceCents, '0');
  assert.ok((await ledger.getMember(identity, archived.id)).archivedAt);
  await ledger.updateMember(identity, reused.id, { name: reused.name, phone: '012345', expectedVersion: '0' }, task());

  const restored = await ledger.executeCommand(identity, undo);
  assert.equal(restored.balanceAfterCents, '100');
  assert.deepEqual(await ledger.executeCommand(identity, undo), restored);
  const member = await ledger.getMember(identity, archived.id);
  assert.equal(member.archivedAt, null);
  assert.equal(member.version, '2');
  const opened = await ledger.changes(identity, { ledgerEpoch: book.ledgerEpoch, after: String(BigInt(restored.cursor) - 1n) });
  assert.equal(opened.items[0].value.archivedAt, null);
  assert.equal(opened.items[0].value.balanceCents, '100');

  await command(archived.id, 'reverse', { originalEntryId: topUp.entryId });
  await ledger.archiveMember(identity, archived.id, task());
  const backup = await ledger.exportBackup(identity);
  assert.equal(backup.tables.audit_events.filter(a => a.event === 'member_archived').length, 2);
  assert.equal(backup.tables.audit_events.filter(a => a.event === 'member_reactivated').length, 1);
  assert.equal((await ledger.exportArchive(identity, { write() {} })).entryCount, 4);
});

test('profile versions, archive guards, tenant isolation and pagination preserve exact boundaries', async () => {
  await ledger.importOpeningBalances(identity, input());
  const ids = []; let cursor; do { const page = await ledger.listMembers(identity, { limit: '7', cursor }); ids.push(...page.items.map(row => row.id)); cursor = page.nextCursor; } while (cursor);
  assert.equal(ids.length, 91); assert.equal(new Set(ids).size, 91);
  await ledger.updateMember(identity, 'member-1', { name: '新姓名', expectedVersion: '0' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
  await assert.rejects(ledger.updateMember(identity, 'member-1', { name: '旧版本', expectedVersion: '0' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch }), { code: 'MEMBER_VERSION_CHANGED' });
  await assert.rejects(ledger.archiveMember(identity, 'member-0', { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch }), { status: 409 });
  await ledger.archiveMember(identity, 'member-1', { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch }); await assert.rejects(command('member-1'), { status: 409 });
  assert.equal((await ledger.listMembers(identity, { search: '新姓名' })).items.length, 0);
  const otherStore = await service.createOwner({ username: 'other-owner', password });

  const other = await service.login({ username: 'other-owner', password, deviceId: randomUUID() }, '127.0.0.1');
  const otherIdentity = await service.authenticate(other.accessToken);
  await assert.rejects(ledger.getMember(otherIdentity, 'member-0'), { status: 404 });
  assert.equal((await ledger.listMembers(otherIdentity)).items.length, 0);
});

test('sync pagination emits materialized values, account versions, archive markers and reversal updates', async () => {
  const a = await ledger.createMember(identity, { name: 'A' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch }), b = await ledger.createMember(identity, { name: 'B' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
  const charge = await command(a.id); await ledger.executeCommand(identity, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'reverse', memberId: a.id, originalEntryId: charge.entryId, expectedAccountVersion: '1' });
  await ledger.archiveMember(identity, b.id, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
  let after = '0', more = true; const items = [];
  while (more) { const page = await ledger.changes(identity, { ledgerEpoch: identity.ledgerEpoch, after, limit: '2' }); items.push(...page.items); assert.ok(BigInt(page.cursor) > BigInt(after)); after = page.cursor; more = page.hasMore; }
  assert.equal(new Set(items.map(item => item.cursor)).size, items.length); assert.ok(items.every(item => item.value));
  assert.ok(items.some(item => item.entityId === b.id && item.changeType === 'archive' && item.value.archivedAt));
  assert.ok(items.some(item => item.entityId === charge.entryId && item.value.reversed));
  assert.equal((await ledger.changes(identity, { ledgerEpoch: identity.ledgerEpoch, after })).items.length, 0);
  await assert.rejects(ledger.changes(identity, { ledgerEpoch: identity.ledgerEpoch, after: '9223372036854775807' }), { code: 'CURSOR_AHEAD' });
  await pool.query('DELETE FROM store_changes WHERE store_id=$1 AND cursor=2', [identity.store_id]);
  await assert.rejects(ledger.changes(identity, { ledgerEpoch: identity.ledgerEpoch, after: '1', limit: '1' }), { code: 'CURSOR_HISTORY_INCOMPLETE' });
  await pool.query('DELETE FROM store_changes WHERE store_id=$1 AND cursor=$2', [identity.store_id, after]);
  await assert.rejects(ledger.changes(identity, { ledgerEpoch: identity.ledgerEpoch, after: String(BigInt(after) - 1n) }), { code: 'CURSOR_HISTORY_INCOMPLETE' });
});

test('HTTP v2 enforces authentication, JSON contracts and service-side permissions', async () => {
  assert.equal((await fetch(origin + '/api/v2/members')).status, 401);
  const headers = { authorization: 'Bearer ' + accessToken, 'content-type': 'application/json' };
  const created = await fetch(origin + '/api/v2/tasks', { method: 'POST', headers, body: JSON.stringify({ id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'member.create', data: { name: 'HTTP会员' } }) });
  assert.equal(created.status, 200); const { result: member } = await created.json(); assert.equal(member.balanceCents, '0');
  const result = await fetch(origin + '/api/v2/commands', { method: 'POST', headers, body: JSON.stringify({ id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'recharge', memberId: member.id, expectedAccountVersion: '0', actualPayCents: 100 }) });
  assert.equal(result.status, 400); assert.equal(await count('ledger_entries'), 0);
  assert.equal((await fetch(origin + '/api/v2/members?limit=101', { headers })).status, 400);
});

test('member and ledger HTTP pages are filtered in SQL and cursors cannot be reused with another query or store', async () => {
  await ledger.importOpeningBalances(identity, input());
  const read = async path => {
    const res = await fetch(origin + '/api/v2' + path, { headers: { authorization: 'Bearer ' + accessToken } });
    return { status: res.status, body: await res.json() };
  };
  const epoch = '&ledgerEpoch=' + identity.ledgerEpoch;
  const query = '?search=' + encodeURIComponent('001000') + '&balance=low&limit=2' + epoch;
  const first = await read('/members' + query); assert.equal(first.status, 200);
  assert.deepEqual(first.body.items.map(row => row.id), ['member-1', 'member-10']);
  assert.equal(first.body.items[0].balanceCents, '0'); assert.ok(first.body.nextCursor);
  const next = '&cursor=' + first.body.nextCursor;
  assert.deepEqual((await read('/members' + query + next)).body.items.map(row => row.id), ['member-11', 'member-13']);
  assert.equal((await read('/members' + query.replace('low', 'positive') + next)).body.code, 'CURSOR_SCOPE_MISMATCH');
  assert.equal((await read('/members' + query.replace('001000', '001') + next)).body.code, 'CURSOR_SCOPE_MISMATCH');
  assert.equal((await read('/members?balance=debt' + epoch)).body.items[0].balanceCents, '-1010');
  await ledger.executeTask(identity, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'member.archive', memberId: 'member-1', data: {} });
  assert.deepEqual((await read('/members?balance=archived' + epoch)).body.items.map(row => row.id), ['member-1']);
  assert.equal((await read('/members' + query)).body.items[0].id, 'member-10');
  const debit = await command('member-10', 'consume'), pay = await command('member-10');
  await command('member-11', 'consume');
  const reversal = await command('member-10', 'reverse', { originalEntryId: debit.entryId });
  const memberSearch = encodeURIComponent('合成会员10');
  const history = await read('/ledger?search=' + memberSearch + '&limit=1' + epoch);
  assert.deepEqual(history.body.items.map(row => [row.id, row.memberName, row.originalEntryId]), [[reversal.entryId, '合成会员10', debit.entryId]]);
  const historyNext = '&cursor=' + history.body.nextCursor;
  assert.equal((await read('/ledger?search=' + memberSearch + '&limit=1' + epoch + historyNext)).body.items[0].id, pay.entryId);
  assert.equal((await read('/ledger?search=' + memberSearch + '&kind=consume' + epoch + historyNext)).body.code, 'CURSOR_SCOPE_MISMATCH');
  const filtered = (await read('/ledger?kind=consume&memberId=member-10' + epoch)).body.items;
  assert.deepEqual(filtered.map(row => [row.id, row.reversalEntryId]), [[debit.entryId, reversal.entryId]]);
  assert.deepEqual((await read('/ledger?from=2000-01-01T00:00:00Z&to=2000-01-02T00:00:00Z' + epoch)).body.items, []);
  assert.equal((await read('/ledger?from=2000-01-01T00:00:00Z' + epoch)).status, 400);
  const other = await service.createOwner({ username: 'different-store', password });
  await pool.query("UPDATE stores SET ledger_epoch=$1 WHERE id=$2", [identity.ledgerEpoch, other.storeId]);
  const otherSession = await service.login({ username: 'different-store', password, deviceId: randomUUID() }, '127.0.0.1');
  const res = await fetch(origin + '/api/v2/members' + query + next, { headers: { authorization: 'Bearer ' + otherSession.accessToken } });
  assert.equal(res.status, 400); assert.equal((await res.json()).code, 'CURSOR_SCOPE_MISMATCH');
});


test('authorization is rechecked inside the transaction after session or license revocation', async () => {
  const member = await ledger.createMember(identity, { name: '授权重检' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
  await pool.query('UPDATE sessions SET revoked=true WHERE id=$1', [identity.sessionId]);
  await assert.rejects(command(member.id), { status: 401 });
  await pool.query('UPDATE sessions SET revoked=false WHERE id=$1', [identity.sessionId]);
  await pool.query('UPDATE store_licenses SET active=false WHERE store_id=$1', [identity.store_id]);
  await assert.rejects(command(member.id), { code: 'LICENSE_REQUIRED' });
  assert.equal(await count('ledger_entries'), 0);
});

test('financial statement and audit failures roll back account, entry, receipt and sync head together', async () => {
  const member = await ledger.createMember(identity, { name: '原子性故障' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
  let failure;
  const faultyPool = { async connect() { const client = await pool.connect(); return {
    query(sql, parameters) { if (failure && sql.includes(failure)) return Promise.reject(new Error('injected SQL failure')); return client.query(sql, parameters); },
    release(discard) { client.release(discard); }
  }; } };
  const faulty = createService(faultyPool).relational;
  const head = (await ledger.changes(identity, { ledgerEpoch: identity.ledgerEpoch })).head;
  for (const point of ['INSERT INTO ledger_entries', 'UPDATE member_accounts', 'INSERT INTO ledger_command_receipts', 'INSERT INTO store_changes', 'INSERT INTO audit_events', 'COMMIT']) {
    failure = point;
    await assert.rejects(faulty.executeCommand(identity, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'recharge', memberId: member.id, expectedAccountVersion: '0', actualPayCents: '100' }), /injected/);
    failure = null;
    assert.equal((await ledger.getMember(identity, member.id)).balanceCents, '0');
    assert.equal(await count('ledger_entries'), 0); assert.equal(await count('ledger_command_receipts'), 0);
    assert.equal((await ledger.changes(identity, { ledgerEpoch: identity.ledgerEpoch })).head, head);
  }
});

test('microsecond keyset boundaries are lossless and invalid calendar cursors fail as input errors', async () => {
  await ledger.importOpeningBalances(identity, input());
  for (let i = 0; i < 3; i++) await pool.query('UPDATE member_profiles SET created_at=$1 WHERE store_id=$2 AND id=$3', ['2020-01-01T00:00:00.00000' + (i + 1) + 'Z', identity.store_id, 'member-' + i]);
  const ids = []; let cursor;
  for (let i = 0; i < 3; i++) { const page = await ledger.listMembers(identity, { cursor, limit: '1' }); ids.push(page.items[0].id); cursor = page.nextCursor; }
  assert.deepEqual(ids, ['member-0', 'member-1', 'member-2']);
  const invalidCursor = Buffer.from(JSON.stringify({ at: '2026-02-30T00:00:00Z', id: 'member-1' })).toString('base64url');
  await assert.rejects(ledger.listMembers(identity, { cursor: invalidCursor }), { status: 400 });
});

const configuration = () => ({ expectedVersion: '0', services: [{ id: 'cut', name: '剪发', priceCents: '1010' }], rechargePlans: [{ id: 'plan', payCents: '10000', giftCents: '1000' }], rechargeSettings: { giftEnabled: true, giftRateBasisPoints: 1000 } });
test('configuration is tenant scoped, optimistic, permission checked and published as a materialized incremental', async () => {
  assert.equal((await ledger.getConfiguration(identity)).version, '0');
  const saved = await ledger.updateConfiguration(identity, configuration(), { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch }); assert.equal(saved.version, '1'); assert.equal(saved.services[0].priceCents, '1010');
  await assert.rejects(ledger.updateConfiguration(identity, configuration(), { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch }), { code: 'CONFIGURATION_VERSION_CHANGED' });
  const page = await ledger.changes(identity, { ledgerEpoch: identity.ledgerEpoch }); assert.equal(page.items.length, 1); assert.deepEqual(page.items[0].value, { id: 'store', ...saved });
  await pool.query("UPDATE users SET role='clerk' WHERE id=$1", [identity.id]);
  assert.equal((await ledger.getConfiguration(identity)).version, '1');
  await assert.rejects(ledger.updateConfiguration(identity, { ...configuration(), expectedVersion: '1' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch }), { status: 403 });
  const headers = { authorization: 'Bearer ' + accessToken, 'content-type': 'application/json' };
  assert.equal((await fetch(origin + '/api/v2/configuration', { headers })).status, 200);
  assert.equal((await fetch(origin + '/api/v2/tasks', { method: 'POST', headers, body: JSON.stringify({ id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'configuration.update', data: { ...configuration(), expectedVersion: '1' } }) })).status, 403);
});
test('immutable sale snapshots survive repricing, disabled plans, reversal and original-command retry', async () => {
  await ledger.updateConfiguration(identity, configuration(), { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch }); const member = await ledger.createMember(identity, { name: '成交测试' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
  const request = { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, actorId: identity.id, deviceId: identity.device_id, type: 'recharge', memberId: member.id, expectedAccountVersion: '0', configurationVersion: '1', planId: 'plan', actualPayCents: '10000', giftCents: '1000', payments: [{ method: '现金', amountCents: '9000' }, { method: '微信', amountCents: '1000' }] };
  for (const extra of [{ actorId: randomUUID() }, { deviceId: randomUUID() }]) await assert.rejects(ledger.executeCommand(identity, { ...request, ...extra }), { status: 403 });
  assert.equal(await count('ledger_entries'), 0);
  const receipt = await ledger.executeCommand(identity, request);
  const spent = await command(member.id, 'consume', { amountCents: '2020', configurationVersion: '1', items: [{ serviceId: 'cut', name: '剪发', quantity: 2, unitPriceCents: '1010' }] });
  await ledger.updateConfiguration(identity, { expectedVersion: '1', services: [{ id: 'cut', name: '新剪发', priceCents: '9999' }], rechargePlans: [], rechargeSettings: { giftEnabled: false, giftRateBasisPoints: 0 } }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
  assert.deepEqual(await ledger.executeCommand(identity, request), receipt);
  await assert.rejects(command(member.id, 'consume', { amountCents: '2020', configurationVersion: '1', items: [{ serviceId: 'cut', name: '剪发', quantity: 2, unitPriceCents: '1010' }] }), { code: 'CONFIGURATION_VERSION_CHANGED' });
  await assert.rejects(command(member.id, 'recharge'), { code: 'GIFT_DISABLED' });
  await ledger.executeCommand(identity, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'reverse', memberId: member.id, expectedAccountVersion: '2', originalEntryId: spent.entryId });
  const entries = (await ledger.listLedger(identity)).items;
  assert.deepEqual(entries.find(row => row.id === request.id).payments, request.payments);
  assert.equal(entries.find(row => row.id === request.id).recharge.configurationVersion, '1');
  assert.equal(entries.find(row => row.id === spent.entryId).items[0].name, '剪发');
  assert.equal(entries.find(row => row.id === spent.entryId).items[0].lineTotalCents, '2020');
  assert.equal(await count('consumption_items'), 1); assert.equal(await count('payment_records'), 2); assert.equal(await count('recharge_details'), 1);
});
test('sale-detail and configuration failures roll back every financial and publication effect', async () => {
  const member = await ledger.createMember(identity, { name: '明细故障' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch }); let failure;
  const faulty = createService({ async connect() { const client = await pool.connect(); return { query(sql, params) { if (failure && sql.includes(failure)) throw new Error('injected detail failure'); return client.query(sql, params); }, release(discard) { client.release(discard); } }; } }).relational;
  for (const point of ['INSERT INTO payment_records', 'INSERT INTO recharge_details']) {
    const head = (await ledger.changes(identity, { ledgerEpoch: identity.ledgerEpoch })).head; failure = point;
    await assert.rejects(faulty.executeCommand(identity, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'recharge', memberId: member.id, expectedAccountVersion: '0', actualPayCents: '100' }), /injected/); failure = null;
    assert.equal((await ledger.getMember(identity, member.id)).balanceCents, '0'); assert.equal((await ledger.changes(identity, { ledgerEpoch: identity.ledgerEpoch })).head, head);
    for (const table of ['ledger_entries', 'payment_records', 'recharge_details', 'ledger_command_receipts']) assert.equal(await count(table), 0);
  }
  failure = 'INSERT INTO service_catalog'; await assert.rejects(faulty.updateConfiguration(identity, configuration(), { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch }), /injected/); failure = null;
  assert.equal((await ledger.getConfiguration(identity)).version, '0'); assert.equal(await count('service_catalog'), 0);
});

test('SQL reports separate gross, reversal and net amounts with keyset pages over historical service and payment snapshots', async () => {
  const member = await ledger.createMember(identity, { name: '报表' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
  const charge = await command(member.id, 'recharge', { actualPayCents: '10000', giftCents: '1000', payments: [{ method: '现金', amountCents: '9000' }, { method: '微信', amountCents: '1000' }] });
  const spent = await command(member.id, 'consume', { amountCents: '2020', items: [{ name: '剪发', quantity: 2, unitPriceCents: '1010' }] });
  await ledger.executeCommand(identity, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'reverse', memberId: member.id, expectedAccountVersion: '2', originalEntryId: spent.entryId });
  const period = { from: '2020-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' };
  let report = await ledger.report(identity, period); assert.equal(report.actualPayCents, '10000'); assert.equal(report.netActualPayCents, '10000'); assert.equal(report.consumptionCents, '2020'); assert.equal(report.reversedConsumptionCents, '2020'); assert.equal(report.netConsumptionCents, '0');
  const methods = []; let cursor; do { const page = await ledger.reportBreakdown(identity, { ...period, kind: 'payment', limit: '1', cursor }); methods.push(...page.items); cursor = page.nextCursor; } while (cursor);
  assert.equal(methods.length, 2); assert.equal(methods.reduce((sum, row) => sum + BigInt(row.amountCents), 0n), 10000n);
  const services = await ledger.reportBreakdown(identity, { ...period, kind: 'service' }); assert.deepEqual(services.items, [{ name: '剪发', serviceId: null, quantity: '0', amountCents: '0' }]);
  await ledger.executeCommand(identity, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'reverse', memberId: member.id, expectedAccountVersion: '3', originalEntryId: charge.entryId });
  report = await ledger.report(identity, period); assert.equal(report.netActualPayCents, '0'); assert.equal(report.netGiftCents, '0'); assert.equal(report.reversedActualPayCents, '10000'); assert.equal(report.netChangeCents, '0');
  assert.ok((await ledger.reportBreakdown(identity, { ...period, kind: 'payment' })).items.every(row => row.amountCents === '0'));
  const firstPage = await ledger.reportBreakdown(identity, { ...period, kind: 'payment', limit: '1' });
  await assert.rejects(ledger.reportBreakdown(identity, { ...period, kind: 'service', cursor: firstPage.nextCursor }), { status: 400 });
  await assert.rejects(ledger.reportBreakdown(identity, { ...period, kind: 'payment', limit: '101' }), { status: 400 });
  await pool.query("UPDATE ledger_entries SET occurred_at='2019-01-01T00:00:00Z' WHERE store_id=$1 AND entry_id=$2", [identity.store_id, charge.entryId]);
  const laterPeriod = await ledger.report(identity, period); assert.equal(laterPeriod.actualPayCents, '0'); assert.equal(laterPeriod.netActualPayCents, '-10000'); assert.equal(laterPeriod.netChangeCents, '-11000');
  assert.equal((await ledger.reportBreakdown(identity, { ...period, kind: 'payment' })).items.reduce((sum, row) => sum + BigInt(row.amountCents), 0n), -10000n);
});

test('HTTP task route accepts bounded configuration and sale sizes and permits POST preflight', async () => {
  const preflight = await fetch(origin + '/api/v2/tasks', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' } });
  assert.equal(preflight.status, 204); assert.ok(preflight.headers.get('access-control-allow-methods').split(/,\s*/).includes('POST'));
  const headers = { authorization: 'Bearer ' + accessToken, 'content-type': 'application/json' };
  const config = { ...configuration(), services: Array.from({ length: 500 }, (_, index) => ({ id: 'service-' + index, name: '合成服务'.repeat(30), priceCents: '1' })) };
  const updated = await fetch(origin + '/api/v2/tasks', { method: 'POST', headers, body: JSON.stringify({ id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'configuration.update', data: config }) }); assert.equal(updated.status, 200); assert.equal((await updated.json()).result.services.length, 500);
  const member = await ledger.createMember(identity, { name: '大请求' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
  const response = await fetch(origin + '/api/v2/commands', { method: 'POST', headers, body: JSON.stringify({ id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, memberId: member.id, type: 'consume', expectedAccountVersion: '0', amountCents: '100', allowDebt: true, items: Array.from({ length: 100 }, () => ({ name: '成交项目'.repeat(30), quantity: 1, unitPriceCents: '1' })) }) });
  assert.equal(response.status, 200); assert.equal((await ledger.listLedger(identity)).items[0].items.length, 100);
});

test('durable member/configuration tasks replay their original committed result and publish only once', async () => {
  const create = { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'member.create', data: { name: ' 原姓名 ', phone: '001', tags: ['😀', '\uE000', '中', 'A'] } };
  const duplicates = await Promise.all(Array.from({ length: 100 }, () => ledger.executeTask(identity, create))), original = duplicates[0];
  for (const result of duplicates) assert.deepEqual(result, original); assert.equal(await count('member_profiles'), 1);
  assert.deepEqual(original.tags, ['A', '中', '\uE000', '😀']); assert.deepEqual((await ledger.getMember(identity, original.id)).tags, original.tags);
  assert.equal(await count('application_task_receipts'), 1); assert.equal((await ledger.changes(identity, { ledgerEpoch: identity.ledgerEpoch })).head, '1');
  const update = { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'member.update', memberId: original.id, data: { name: '新姓名', expectedVersion: '0', tags: ['新标签'] } }, updated = await ledger.executeTask(identity, update);
  await command(original.id);
  const configurationTask = { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'configuration.update', data: configuration() }, saved = await ledger.executeTask(identity, configurationTask);
  await ledger.updateConfiguration(identity, { ...configuration(), expectedVersion: '1', services: [] }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
  for (const [request, result] of [[create, original], [update, updated], [configurationTask, saved]]) {
    assert.deepEqual(await ledger.executeTask(identity, request), result); assert.deepEqual((await ledger.getTask(identity, request.id, { ledgerEpoch: identity.ledgerEpoch })).result, result);
  }
  const zero = await ledger.createMember(identity, { name: '归档任务' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch }), archive = { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'member.archive', memberId: zero.id, data: {} };
  await ledger.executeTask(identity, archive); assert.deepEqual(await ledger.executeTask(identity, archive), { success: true });
  await assert.rejects(ledger.executeTask(identity, { ...create, data: { name: 'different' } }), { code: 'TASK_CONFLICT' });
  await assert.rejects(ledger.executeTask(identity, { ...update, memberId: zero.id }), { code: 'TASK_CONFLICT' });
  await assert.rejects(ledger.executeTask(identity, { ...create, storeId: 'wrong' }), { status: 400 });
  await assert.rejects(ledger.createMember(identity, { name: 'missing task' }), { status: 400 });
});

test('HTTP task responses can be recovered and replayed under the original identity; other devices and revoked permissions fail closed', async () => {
  const headers = { authorization: 'Bearer ' + accessToken, 'content-type': 'application/json' }, task = { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'member.create', actorId: identity.id, deviceId: identity.device_id, data: { name: '响应丢失模拟' } };
  const first = await fetch(origin + '/api/v2/tasks', { method: 'POST', headers, body: JSON.stringify(task) }); assert.equal(first.status, 200); const saved = await first.json();
  assert.equal(saved.taskId, task.id); assert.equal(saved.ledgerEpoch, task.ledgerEpoch); assert.equal(saved.type, task.type);
  const recovered = await fetch(origin + '/api/v2/tasks/' + task.id + '?ledgerEpoch=' + identity.ledgerEpoch, { headers }); assert.equal(recovered.status, 200); const { completedAt, ...receipt } = await recovered.json(); assert.ok(Date.parse(completedAt)); assert.deepEqual(receipt, saved);
  const second = await fetch(origin + '/api/v2/tasks', { method: 'POST', headers, body: JSON.stringify(task) }); assert.deepEqual(await second.json(), saved);
  const other = await service.login({ username: 'relational-owner', password, deviceId: randomUUID() }, '127.0.0.1'), otherIdentity = await service.authenticate(other.accessToken);
  await assert.rejects(ledger.getTask(otherIdentity, task.id, { ledgerEpoch: identity.ledgerEpoch }), { code: 'TASK_NOT_FOUND' });
  await assert.rejects(ledger.executeTask(otherIdentity, { ...task, deviceId: otherIdentity.device_id }), { code: 'TASK_CONFLICT' });
  await pool.query("UPDATE users SET role='viewer' WHERE id=$1", [identity.id]);
  await assert.rejects(ledger.executeTask(identity, task), { status: 403 });
  assert.equal((await fetch(origin + '/api/v2/members', { method: 'POST', headers, body: JSON.stringify({ name: 'untracked' }) })).status, 404);
});

test('task receipt, task audit and commit failures roll back the business result and incremental head', async () => {
  let failure;
  const faultyPool = { async connect() { const client = await pool.connect(); return {
    query(sql, parameters) {
      if (failure && (sql.includes(failure) || failure === 'task_audit' && sql.startsWith('INSERT INTO audit_events') && parameters?.[3] === 'task_completed')) return Promise.reject(new Error('injected task SQL failure'));
      return client.query(sql, parameters);
    }, release(discard) { client.release(discard); }
  }; } }, faulty = createService(faultyPool).relational;
  for (const point of ['INSERT INTO application_task_receipts', 'task_audit', 'COMMIT']) {
    const request = { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'member.create', data: { name: '原子任务' } }, before = await count('member_profiles'), head = (await ledger.changes(identity, { ledgerEpoch: identity.ledgerEpoch })).head;
    failure = point; await assert.rejects(faulty.executeTask(identity, request), /injected/); failure = null;
    assert.equal(await count('member_profiles'), before); assert.equal((await ledger.changes(identity, { ledgerEpoch: identity.ledgerEpoch })).head, head);
    await assert.rejects(ledger.getTask(identity, request.id, { ledgerEpoch: identity.ledgerEpoch }), { code: 'TASK_NOT_FOUND' });
    const saved = await ledger.executeTask(identity, request); assert.deepEqual(await ledger.executeTask(identity, request), saved);
  }
});

test('business SQL report fills the calendar, excludes opening/new archived members, and ranks occurrence-period net consumption', async () => {
  await ledger.importOpeningBalances(identity, input());
  const a = await ledger.createMember(identity, { name: '排行 A' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch }), b = await ledger.createMember(identity, { name: '排行 B' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
  const archived = await ledger.createMember(identity, { name: '归档新客' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch }); await ledger.archiveMember(identity, archived.id, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
  await command(a.id); const consumed = await command(a.id, 'consume', { amountCents: '50' }); await command(b.id, 'consume', { amountCents: '1', allowDebt: true });
  await ledger.executeCommand(identity, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'reverse', memberId: a.id, originalEntryId: consumed.entryId, expectedAccountVersion: '2' });
  const range = { from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 86400000).toISOString(), offsetMinutes: '480' }, result = await ledger.reportBusiness(identity, range);
  assert.equal(result.summary.newActiveMemberCount, 2); assert.equal(result.summary.rechargeCount, 1); assert.equal(result.summary.consumeCount, 2); assert.equal(result.summary.reversalCount, 1);
  assert.equal(result.summary.consumptionCents, '51'); assert.equal(result.summary.netConsumptionCents, '1'); assert.equal(result.summary.averageConsumeCents, '26'); assert.equal(result.summary.consumeMemberCount, 2);
  assert.deepEqual(result.ranking, [{ memberId: b.id, name: '排行 B', netConsumptionCents: '1', netConsumeCount: 1 }]);
  assert.equal(result.balances.memberCount, 93); assert.equal(result.balances.debtCount, 2); assert.equal(result.trendUnit, 'day'); assert.ok(result.daily.length >= 2);
  assert.equal(result.daily.reduce((sum, row) => sum + BigInt(row.actualPayCents), 0n), 100n);
  const headers = { authorization: 'Bearer ' + accessToken }, response = await fetch(origin + '/api/v2/reports/business?' + new URLSearchParams(range), { headers }); assert.equal(response.status, 200); assert.deepEqual(await response.json(), result);
  await pool.query('UPDATE store_licenses SET features=$1::jsonb WHERE store_id=$2', [JSON.stringify(['core']), identity.store_id]);
  await assert.rejects(ledger.reportBusiness(identity, range), { code: 'FEATURE_DISABLED' });
});

test('business SQL numeric aggregates and ranking exceed signed BIGINT with exact rounded average cents', async () => {
  const member = await ledger.createMember(identity, { name: '大整数排行' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch }), maximum = '9223372036854775807';
  for (let i = 0; i < 2; i++) { await command(member.id, 'recharge', { actualPayCents: maximum, giftCents: '0' }); await command(member.id, 'consume', { amountCents: maximum }); }
  const report = await ledger.reportBusiness(identity, { from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 86400000).toISOString(), offsetMinutes: 0 });
  assert.equal(report.summary.actualPayCents, '18446744073709551614'); assert.equal(report.summary.consumptionCents, '18446744073709551614'); assert.equal(report.summary.averageConsumeCents, maximum); assert.equal(report.ranking[0].netConsumptionCents, '18446744073709551614');
});
