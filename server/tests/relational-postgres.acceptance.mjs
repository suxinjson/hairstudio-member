import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import * as XLSX from 'xlsx';
import { createService } from './helpers/licensed-service.js';
import { relationalTestDatabase } from './helpers/relational-database.js';
import { readRelationalArchive } from '../../src/relational-archive.js';
import { PG_BACKUP_TABLES, validatePostgresRow } from '../relational-backup.js';
import { digest } from '../security.js';
import { signAliGenieRequest } from '../aligenie.js';
import { createApi } from '../http.js';
import { createRelationalRemote } from '../../src/relational-remote.js';
import { createBatchRunner } from '../../src/relational-batch-runner.js';
import { migrate, configureRuntimeRole, configureRecoveryRole, assertRuntimeRole, assertRecoveryRole } from '../database.js';
import { roleTestDatabase } from './helpers/role-database.js';
import { prepareRecoveryTarget } from '../prepare-recovery-target.js';
import { createLedgerExportWorker } from '../relational-export-worker.js';
import { LEDGER_SHEET } from '../../src/relational-export-sheet.js';
import { LICENSE_FEATURES } from '../../src/license-policy.js';

// Deliberately excluded from default *.test.js discovery. The --postgres runner
// requires an explicit disposable database and cannot substitute serialized WASM.
let database, pool, service, ledger, identity, accessToken, a, b;
before(async () => {
  if (!process.env.MEMBER_RELATIONAL_TEST_DATABASE_URL) throw new Error('Real PostgreSQL is required');
  database = await relationalTestDatabase(); pool = database.pool; service = createService(pool); ledger = service.relational;
});
after(async () => { await database?.close(); });
beforeEach(async () => {
  await pool.query('TRUNCATE stores,login_limits RESTART IDENTITY CASCADE');
  const password = 'Postgres-Acceptance-2026!', owner = await service.createOwner({ username: 'pg-owner', password });

  const session = await service.login({ username: 'pg-owner', password, deviceId: randomUUID() }, '127.0.0.1');
  accessToken = session.accessToken; identity = await service.authenticate(accessToken);
  identity.ledgerEpoch = (await ledger.getBook(identity)).ledgerEpoch;
  a = await ledger.createMember(identity, { name: '合成 A' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch }); b = await ledger.createMember(identity, { name: '合成 B' }, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch });
});
const charge = (member, extra = {}) => ledger.executeCommand(identity, { id: randomUUID(), storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'recharge', memberId: member.id, expectedAccountVersion: '0', actualPayCents: '1', ...extra });

test('terminating a dedicated PostgreSQL connection before commit leaves no partial money; the original number works after reconnect', async () => {
  let terminated = false;
  const interrupted = createService({ query: (...args) => pool.query(...args), async connect() {
    const client = await pool.connect();
    return { async query(sql, params) {
      const result = await client.query(sql, params);
      if (!terminated && sql.startsWith('INSERT INTO ledger_command_receipts')) {
        const { rows: [row] } = await pool.query('SELECT pg_terminate_backend($1) AS stopped', [client.processID]);
        assert.equal(row.stopped, true); terminated = true;
        await client.query('SELECT 1');
      }
      return result;
    }, on: client.on.bind(client), off: client.off.bind(client), release(discard) { client.release(discard); } };
  } });
  const { ledgerEpoch, storeId } = await ledger.getBook(identity);
  const command = { id: randomUUID(), storeId, ledgerEpoch, type: 'recharge', memberId: a.id, expectedAccountVersion: '0', actualPayCents: '17' };
  await assert.rejects(interrupted.relational.executeCommand(identity, command));
  assert.equal(terminated, true);
  assert.equal((await ledger.getMember(identity, a.id)).balanceCents, '0');
  for (const table of ['ledger_entries', 'ledger_command_receipts']) {
    assert.equal((await pool.query('SELECT count(*) AS n FROM ' + table + ' WHERE store_id=$1', [storeId])).rows[0].n, '0');
  }
  assert.equal((await pool.query("SELECT count(*) AS n FROM audit_events WHERE store_id=$1 AND event='ledger_recharge'", [storeId])).rows[0].n, '0');
  const result = await ledger.executeCommand(identity, command);
  assert.deepEqual(await ledger.executeCommand(identity, command), result);
  assert.equal(result.balanceAfterCents, '17');
  assert.equal((await ledger.listLedger(identity, { memberId: a.id })).items.length, 1);
});

for (const count of [499, 500]) test(count + ' profile rows finish behind production quotas and a committed group with a lost response is not sent again', { timeout: 90000 }, async t => {
  const server = createApi({ service, pool, production: true, trustedProxyIPs: ['127.0.0.1'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const deviceId = randomUUID(), grant = await service.login({ username: 'pg-owner', password: 'Postgres-Acceptance-2026!', deviceId }, '127.0.0.21');
  const base = 'http://127.0.0.1:' + server.address().port;
  let groupCalls = 0, drop = true; const rowIds = new Set();
  const remote = createRelationalRemote({ async request(path, options) {
    const response = await fetch(base + path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '127.0.0.21', 'X-Forwarded-Proto': 'https', Authorization: 'Bearer ' + grant.accessToken } });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { code: value.code, status: response.status });
    if (path.endsWith('/steps')) {
      groupCalls++;
      for (const id of JSON.parse(options.body).taskIds) { assert.ok(!rowIds.has(id)); rowIds.add(id); }
      if (drop) { drop = false; throw new TypeError('committed group response lost'); }
    }
    return value;
  } });
  const scope = { ...await remote.getBook(), actorId: grant.user.id, deviceId }, batch = { ...scope, id: randomUUID() };
  await remote.captureBatch({ ...batch, sourceDigest: 'a'.repeat(64), items: Array.from({ length: count }, (_, i) => ({
    id: randomUUID(), type: 'member.create', data: { name: '合成大批次 ' + i } })) });
  await remote.controlBatch({ ...batch, expectedVersion: '0', state: 'active' });
  const run = () => createBatchRunner({ repository: remote, getScope: () => scope }).run(batch);
  await assert.rejects(run(), /committed group response lost/);
  assert.equal((await remote.getBatch(batch)).completedCount, 25);
  assert.equal((await run()).completedCount, count);
  assert.equal(groupCalls, 20); assert.equal(rowIds.size, count);
  assert.equal((await pool.query('SELECT count(*) AS n FROM ledger_entries')).rows[0].n, '0');
  assert.equal((await pool.query("SELECT count(*) AS n FROM member_profiles WHERE name LIKE '合成大批次 %'")).rows[0].n, String(count));
});
test('real PostgreSQL arbitrates phone reuse racing the reversal of an archived account', async () => {
  const book = await ledger.getBook(identity), task = () => ({ ...book, id: randomUUID() });
  await ledger.updateMember(identity, a.id, { name: a.name, phone: '+01-234', expectedVersion: '0' }, task());
  await charge(a);
  const spend = await ledger.executeCommand(identity, { ...book, id: randomUUID(), type: 'consume', memberId: a.id, expectedAccountVersion: '1', amountCents: '1' });
  await ledger.archiveMember(identity, a.id, task());
  const results = await Promise.allSettled([
    ledger.createMember(identity, { name: '新会员', phone: '01234' }, task()),
    ledger.executeCommand(identity, { ...book, id: randomUUID(), type: 'reverse', memberId: a.id, originalEntryId: spend.entryId, expectedAccountVersion: '2' })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'MEMBER_PHONE_IN_USE');
  const original = await ledger.getMember(identity, a.id);
  assert.equal(original.balanceCents, results[0].status === 'fulfilled' ? '0' : '1');
  assert.equal(Boolean(original.archivedAt), results[0].status === 'fulfilled');
});
test('real PostgreSQL recovery lock fences an old-generation writer through the final commit boundary', async () => {
  const recovery = await pool.connect(), epoch = randomUUID(); let request;
  try {
    await recovery.query('BEGIN');
    await recovery.query('UPDATE stores SET ledger_epoch=$1 WHERE id=$2', [epoch, identity.store_id]);
    // Attach both handlers immediately so an early rejection never becomes an
    // unhandled rejection. The write must wait for the recovery store lock.
    let settled = false;
    request = charge(a).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(settled, false);
    await recovery.query('COMMIT');
    const result = await deadline(request, 5000); assert.equal(result.error?.code, 'LEDGER_EPOCH_MISMATCH');
    assert.equal((await ledger.getMember(identity, a.id)).balanceCents, '0');
    assert.equal((await ledger.getBook(identity)).ledgerEpoch, epoch);
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM ledger_entries WHERE store_id=$1', [identity.store_id])).rows[0].n), 0);
  } finally { await recovery.query('ROLLBACK'); recovery.release(); if (request) await request; }
});
async function deadline(promise, milliseconds) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Independent account failed to make progress')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
test('a held account row lock does not prevent another account from committing', async () => {
  const blocker = await pool.connect(); let waiting, settled = false;
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT member_id FROM member_accounts WHERE store_id=$1 AND member_id=$2 FOR UPDATE', [identity.store_id, a.id]);
    waiting = charge(a).then(value => { settled = true; return value; });
    // Attach an error observer immediately; the assertion still awaits the
    // original promise after releasing the lock in all paths.
    waiting.catch(() => {});
    const completed = await deadline(charge(b), 3000); assert.equal(completed.balanceAfterCents, '1'); assert.equal(settled, false);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); if (waiting) await waiting; }
});
test('real PostgreSQL voice serializes one dialog while a distinct dialog can commit', async () => {
  const secret = 'voice-pg-acceptance-' + randomUUID(), storeId = identity.store_id;
  await service.saveVoiceConfig(identity, { aligenie: { enabled: true, actorId: identity.id, token: secret, allowedDevices: ['pg-voice-device'] } }, 0);
  const request = (sessionId, utterance, extra = {}) => ({ sessionId, requestId: randomUUID(), utterance,
    requestData: { deviceOpenId: 'pg-voice-device', userOpenId: 'pg-voice-user' }, ...extra });
  function send(body, instance = service) {
    const timestamp = String(Date.now());
    return instance.handleAliGenieWebhook(body, { headers: { 'x-store-id': storeId, 'x-aligenie-timestamp': timestamp,
      'x-aligenie-signature': signAliGenieRequest(secret, timestamp, storeId, body) } });
  }
  const previewA = request('pg-dialog-a', '合成 A 充值 1 元'), previewB = request('pg-dialog-b', '合成 B 充值 2 元');
  assert.equal((await send(previewA)).returnValue.resultType, 'CONFIRM');
  assert.equal((await send(previewB)).returnValue.resultType, 'CONFIRM');
  const confirmationA = request(previewA.sessionId, '确认', { confirmationRequestId: previewA.requestId });
  const confirmationB = request(previewB.sessionId, '确认', { confirmationRequestId: previewB.requestId });

  let markEntered;
  const entered = new Promise(resolve => { markEntered = resolve; });
  const observedService = createService({ query: (sql, params) => pool.query(sql, params), async connect() {
    const client = await pool.connect();
    return { async query(sql, params) {
      if (sql.startsWith('SELECT member_id,balance_cents,version FROM member_accounts') && params[1] === a.id) markEntered();
      return client.query(sql, params);
    }, release: (...args) => client.release(...args) };
  } });
  const blocker = await pool.connect(), waiting = [];
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT member_id FROM member_accounts WHERE store_id=$1 AND member_id=$2 FOR UPDATE', [storeId, a.id]);
    let settled = false;
    const first = send(confirmationA, observedService).finally(() => { settled = true; });
    waiting.push(first); first.catch(() => {});
    await deadline(entered, 3000);
    const duplicate = send(confirmationA); waiting.push(duplicate); duplicate.catch(() => {});
    const other = await deadline(send(confirmationB), 3000);
    assert.match(other.returnValue.reply, /充值成功/); assert.equal(settled, false);
    assert.equal((await ledger.getMember(identity, b.id)).balanceCents, '220');
    assert.equal((await ledger.getMember(identity, a.id)).balanceCents, '0');
    await blocker.query('ROLLBACK');
    const [result, replay] = await deadline(Promise.all(waiting), 5000);
    assert.deepEqual(result, replay); assert.match(result.returnValue.reply, /充值成功/);
    assert.equal((await ledger.getMember(identity, a.id)).balanceCents, '110');
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM ledger_command_receipts WHERE store_id=$1', [storeId])).rows[0].n), 2);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await Promise.allSettled(waiting); }
});
test('same command ID across different accounts and payloads has one immutable committed effect', async () => {
  const id = randomUUID();
  const results = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => charge(index % 2 ? a : b, { id, actualPayCents: String(index + 1) })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'COMMAND_CONFLICT'));
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM ledger_entries')).rows[0].n), 1);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM ledger_command_receipts')).rows[0].n), 1);
});

test('real PostgreSQL 10/50/100 waves separate successful independent accounts from hotspot version conflicts', async t => {
  const scope = { storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch }, accounts = [];
  for (let i = 0; i < 100; i++) accounts.push(await ledger.createMember(identity, { name: '合成并发 ' + i }, { ...scope, id: randomUUID() }));
  const versions = accounts.map(() => 0);
  let hotspotVersion = 0, total = 0;
  for (const width of [10, 50, 100]) {
    const start = performance.now();
    const independent = await Promise.allSettled(accounts.slice(0, width).map((member, i) => charge(member, { expectedAccountVersion: String(versions[i]) })));
    const independentMs = performance.now() - start;
    const results = independent.map((result, i) => {
      assert.equal(result.status, 'fulfilled', result.reason?.message);
      assert.deepEqual([result.value.memberId, result.value.accountVersion, result.value.balanceAfterCents],
        [accounts[i].id, String(++versions[i]), String(versions[i])]);
      return result.value.entryId;
    });
    assert.equal(new Set(results).size, width);
    const hotStart = performance.now();
    const hot = await Promise.allSettled(Array.from({ length: width }, () => charge(a, { expectedAccountVersion: String(hotspotVersion) })));
    const hotspotsMs = performance.now() - hotStart, accepted = hot.filter(result => result.status === 'fulfilled');
    const rejected = hot.filter(result => result.status === 'rejected');
    assert.equal(accepted.length, 1); assert.equal(rejected.length, width - 1);
    assert.ok(rejected.every(result => result.reason.code === 'ACCOUNT_VERSION_CHANGED'));
    assert.equal(accepted[0].value.balanceAfterCents, String(++hotspotVersion));
    total += width + 1;
    t.diagnostic(JSON.stringify({ width, independentAccepted: width, independentMs: Math.round(independentMs),
      hotspotAccepted: 1, hotspotVersionConflicts: rejected.length, hotspotMs: Math.round(hotspotsMs), poolConnections: pool.totalCount }));
  }
  const { rows: [saved] } = await pool.query("SELECT (SELECT count(*) FROM ledger_entries WHERE store_id=$1) AS entries,(SELECT count(*) FROM ledger_command_receipts WHERE store_id=$1) AS receipts,(SELECT count(*) FROM audit_events WHERE store_id=$1 AND event='ledger_recharge') AS audits,(SELECT sum(balance_cents) FROM member_accounts WHERE store_id=$1) AS balance", [scope.storeId]);
  assert.deepEqual(Object.values(saved).map(String), Array(4).fill(String(total)));
});

test('50 concurrent reversals link the original once, including an original retry after the race', async () => {
  const original = await charge(a, { actualPayCents: '42' });
  const base = { storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, memberId: a.id, expectedAccountVersion: '1',
    type: 'reverse', originalEntryId: original.entryId };
  const requests = Array.from({ length: 50 }, () => ({ ...base, id: randomUUID() }));
  const outcomes = await Promise.allSettled(requests.map(request => ledger.executeCommand(identity, request)));
  const winners = outcomes.flatMap((result, i) => result.status === 'fulfilled' ? [{ index: i, receipt: result.value }] : []);
  assert.equal(winners.length, 1);
  assert.ok(outcomes.every(result => result.status === 'fulfilled' || result.reason.code === 'ACCOUNT_VERSION_CHANGED'));
  const [{ index, receipt }] = winners;
  assert.equal(receipt.balanceAfterCents, '0');
  assert.deepEqual(await ledger.executeCommand(identity, requests[index]), receipt);
  await assert.rejects(ledger.executeCommand(identity, { ...base, id: randomUUID(), expectedAccountVersion: '2' }), { code: 'ALREADY_REVERSED' });
  const page = await ledger.listLedger(identity, { memberId: a.id });
  assert.deepEqual(page.items.map(entry => [entry.id, entry.deltaCents, entry.originalEntryId, entry.reversalEntryId]),
    [[receipt.entryId, '-42', original.entryId, null], [original.entryId, '42', null, receipt.entryId]]);
});

test('20 concurrent stores can commit the same command ID without cross-tenant results or constraint conflicts', async () => {
  const merchants = [], id = randomUUID(), password = 'Synthetic-Pg-Store-2026!';
  for (let i = 0; i < 20; i++) {
    const username = 'synthetic-tenant-' + i;
    await service.createOwner({ username, password });
    const grant = await service.login({ username, password, deviceId: randomUUID() }, '127.0.1.' + (i + 1));
    const actor = await service.authenticate(grant.accessToken), scope = await ledger.getBook(actor);
    const member = await ledger.createMember(actor, { name: '合成租户 ' + i }, { ...scope, id: randomUUID() });
    merchants.push({ actor, scope, member });
  }
  const receipts = await Promise.all(merchants.map(({ actor, scope, member }, i) => ledger.executeCommand(actor, { ...scope, id, memberId: member.id,
    expectedAccountVersion: '0', type: 'recharge', actualPayCents: String(i + 1) })));
  for (const [i, { actor, scope, member }] of merchants.entries()) {
    const receipt = await ledger.getCommand(actor, id, scope);
    assert.deepEqual(receipt, receipts[i]);
    assert.deepEqual([receipt.storeId, receipt.ledgerEpoch, receipt.memberId, receipt.balanceAfterCents], [scope.storeId, scope.ledgerEpoch, member.id, String(i + 1)]);
  }
  const { rows } = await pool.query('SELECT store_id FROM ledger_command_receipts WHERE command_id=$1', [id]);
  assert.deepEqual(new Set(rows.map(row => row.store_id)), new Set(merchants.map(({ scope }) => scope.storeId)));
});

test('100 real HTTP sockets closed after PostgreSQL commits recover the original receipt without a repeat effect', async () => {
  const sockets = new Map(), lost = new Map();
  const apiService = { ...service, relational: { ...ledger, async executeCommand(actor, command) {
    const committed = await ledger.executeCommand(actor, command), socket = sockets.get(command.id);
    if (socket) { lost.set(command.id, committed); sockets.delete(command.id); socket.destroy(); }
    return committed;
  } } };
  const server = createApi({ service: apiService, pool, rateLimits: false });
  server.prependListener('request', request => {
    const id = request.headers['x-fixture-drop-reply']; if (id) sockets.set(id, request.socket);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const route = 'http://127.0.0.1:' + server.address().port + '/api/v2/commands', scope = { storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch };
    const headers = { authorization: 'Bearer ' + accessToken, 'content-type': 'application/json' };
    for (let i = 0; i < 100; i++) {
      const id = randomUUID(), payload = { ...scope, id, type: 'recharge', memberId: a.id, expectedAccountVersion: String(i), actualPayCents: '1' };
      const post = { method: 'POST', body: JSON.stringify(payload) };
      await assert.rejects(fetch(route, { ...post, headers: { ...headers, 'x-fixture-drop-reply': id }, signal: AbortSignal.timeout(5000) }), TypeError);
      assert.ok(lost.has(id), 'Network response must be lost after commit');
      const read = await fetch(route + '/' + id + '?ledgerEpoch=' + scope.ledgerEpoch, { headers, signal: AbortSignal.timeout(5000) });
      assert.equal(read.status, 200); assert.deepEqual(await read.json(), lost.get(id));
      const retry = await fetch(route, { ...post, headers, signal: AbortSignal.timeout(5000) });
      assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), lost.get(id));
    }
    assert.equal(lost.size, 100); assert.equal(sockets.size, 0);
    const member = await ledger.getMember(identity, a.id);
    assert.deepEqual([member.balanceCents, member.accountVersion], ['100', '100']);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('reviewed same-store bootstrap restores all 91 synthetic openings and new business on an independent PostgreSQL database', async t => {
  const target = await roleTestDatabase(); t.after(target.close);
  await migrate(target.pool);
  const { rows: [{ databaseName }] } = await target.pool.query('SELECT current_database() AS "databaseName"');
  const appPassword = target.password(), recoveryPassword = target.password();
  await configureRuntimeRole(target.pool, appPassword); await configureRecoveryRole(target.pool, recoveryPassword);
  const app = target.connect('member_app', appPassword), recovery = target.connect('member_recovery', recoveryPassword);
  await assertRuntimeRole(app); await assertRecoveryRole(recovery);

  const password = target.password(), oldUsername = 'synthetic-cutover-source';
  await service.createOwner({ username: oldUsername, password });
  const authenticate = async (service, username) => service.authenticate((await service.login({ username, password, deviceId: randomUUID() }, '127.0.2.1')).accessToken);
  const sourceActor = await authenticate(service, oldUsername), source = await ledger.getBook(sourceActor);
  const members = Array.from({ length: 91 }, (_, i) => ({ id: 'verified-' + String(i).padStart(2, '0'), name: '合成期初 ' + i,
    phone: '', balanceCents: String((i - 35) * 100) }));
  const openings = { ...source, batchId: 'reviewed-opening-' + randomUUID(), sourceDigest: digest(JSON.stringify(members)), expectedCount: 91, members };
  const previewOpenings = await ledger.previewOpeningImport(sourceActor, openings);
  await ledger.importOpeningBalances(sourceActor, { ...openings, payloadDigest: previewOpenings.payloadDigest });
  const sample = { ...source, id: randomUUID(), type: 'recharge', memberId: members[0].id, expectedAccountVersion: '0', actualPayCents: '4000', giftCents: '11' };
  const credit = await ledger.executeCommand(sourceActor, sample);
  const debit = { ...source, id: randomUUID(), type: 'consume', memberId: members[0].id, expectedAccountVersion: '1', amountCents: '17' };
  await ledger.executeCommand(sourceActor, debit);
  await ledger.executeCommand(sourceActor, { ...source, id: randomUUID(), type: 'reverse', memberId: members[0].id, expectedAccountVersion: '2', originalEntryId: debit.id });

  const dir = await mkdtemp(join(tmpdir(), 'member-reviewed-recovery-')), file = join(dir, 'archive.ndjson');
  t.after(async () => { await rm(file, { force: true }); await rmdir(dir); });
  const archive = await ledger.exportArchive(sourceActor, { ledgerEpoch: source.ledgerEpoch, write: line => appendFile(file, line) });
  const external = await readFile(file); assert.equal(external.byteLength, archive.byteLength);
  const recordedFileHash = digest(external);

  const targetOptions = { databaseName, storeId: source.storeId, username: 'synthetic-cutover-target', storeName: '合成恢复门店', displayName: '当前合成店主' };
  const plan = await prepareRecoveryTarget(target.pool, targetOptions);
  assert.deepEqual(plan, { databaseName, schema: 'public', storeId: source.storeId, status: 'ready', licenseGranted: false });
  const count = async table => Number((await target.pool.query('SELECT count(*) AS n FROM ' + table)).rows[0].n);
  assert.equal(await count('stores'), 0); assert.equal(await count('users'), 0);
  await assert.rejects(prepareRecoveryTarget(target.pool, { ...targetOptions, databaseName: databaseName + '_wrong', apply: true, password }), { code: 'RECOVERY_TARGET_DATABASE' });
  await assert.rejects(prepareRecoveryTarget(app, targetOptions), { code: 'RECOVERY_TARGET_SCHEMA' });
  await assert.rejects(prepareRecoveryTarget(recovery, targetOptions), { code: 'RECOVERY_TARGET_SCHEMA' });
  const race = await Promise.allSettled(Array.from({ length: 2 }, () => prepareRecoveryTarget(target.pool, { ...targetOptions, password, apply: true })));
  assert.equal(race.filter(result => result.status === 'fulfilled' && result.value.status === 'prepared').length, 1);
  assert.deepEqual(race.filter(result => result.status === 'rejected').map(result => result.reason.code), ['RECOVERY_TARGET_NOT_EMPTY']);
  assert.equal(await count('stores'), 1); assert.equal(await count('users'), 1); assert.equal(await count('store_licenses'), 0);
  await target.pool.query('INSERT INTO store_licenses(id,store_id,features,offline_hours,starts_at) VALUES($1,$2,$3,8760,$4)', [randomUUID(), source.storeId, JSON.stringify(LICENSE_FEATURES), '2000-01-01T00:00:00Z']);

  const destination = createService(app, { recoveryPool: recovery }), targetActor = await authenticate(destination, targetOptions.username), dest = destination.relational;
  const empty = await dest.getBook(targetActor);
  assert.equal(empty.storeId, source.storeId); assert.notEqual(empty.ledgerEpoch, source.ledgerEpoch);
  const id = randomUUID(), chosen = { id, ledgerEpoch: empty.ledgerEpoch };
  const preview = await dest.previewArchiveRestore(targetActor, { ...chosen, chunks: createReadStream(file) });
  assert.deepEqual([preview.sourceEpoch, preview.memberCount, preview.entryCount, preview.historicalActorCount, preview.sourceDigest], [source.ledgerEpoch, 91, 3, 1, archive.digest]);
  assert.equal(await count('member_accounts'), 0); assert.equal(await count('ledger_entries'), 0); assert.equal(await count('users'), 1);
  assert.equal(digest(await readFile(file)), recordedFileHash);
  const restore = () => dest.restoreArchive(targetActor, { ...chosen, sourceEpoch: preview.sourceEpoch, reviewedDigest: preview.sourceDigest, chunks: createReadStream(file) });
  const restored = await restore();
  assert.notEqual(restored.ledgerEpoch, empty.ledgerEpoch); assert.notEqual(restored.ledgerEpoch, source.ledgerEpoch);
  const { rows: accounts } = await target.pool.query('SELECT p.id,p.name,a.balance_cents,o.opening_balance_cents,a.version FROM member_accounts a JOIN member_profiles p ON p.store_id=a.store_id AND p.id=a.member_id JOIN account_openings o ON o.store_id=a.store_id AND o.member_id=a.member_id ORDER BY p.id');
  assert.deepEqual(accounts.map(row => [row.id, row.name, row.opening_balance_cents, row.balance_cents, row.version]),
    members.map((m, index) => [m.id, m.name, m.balanceCents, index ? m.balanceCents : credit.balanceAfterCents, index ? '0' : '3']));
  const { rows: [oldActor] } = await target.pool.query('SELECT historical_only,active FROM users WHERE id=$1', [sourceActor.id]);
  assert.deepEqual(oldActor, { historical_only: true, active: false });
  await assert.rejects(dest.executeCommand(targetActor, sample), { code: 'LEDGER_EPOCH_MISMATCH' });
  const followup = await dest.executeCommand(targetActor, { ...sample, id: randomUUID(), ledgerEpoch: restored.ledgerEpoch, expectedAccountVersion: '3', actualPayCents: '1', giftCents: '0' });
  assert.equal(followup.balanceAfterCents, String(BigInt(credit.balanceAfterCents) + 1n));
  // A receipt retry takes no input body. Use an empty async byte source so
  // a duplicate cannot reopen the file or overwrite new business.
  assert.deepEqual(await dest.restoreArchive(targetActor, { ...chosen, sourceEpoch: preview.sourceEpoch, reviewedDigest: preview.sourceDigest, chunks: (async function* () {})() }), restored);
  assert.equal(await count('ledger_entries'), 4);

  const start = Date.now(), exportId = randomUUID();
  const exportScope = { ledgerEpoch: restored.ledgerEpoch };
  await dest.queueLedgerExport(targetActor, { ...exportScope, id: exportId, from: new Date(start - 86400000).toISOString(), to: new Date(start + 86400000).toISOString() });
  const worker = createLedgerExportWorker({ pool: target.connect('member_app', appPassword), jobs: dest });
  try {
    worker.start(); // A separate runtime connection starts the job without another write request.
    let report;
    for (let attempt = 0; attempt < 200; attempt++) {
      report = await dest.getLedgerExport(targetActor, exportScope);
      if (['ready', 'failed'].includes(report.state)) break;
      await delay(100);
    }
    assert.deepEqual([report.state, report.rows, report.failure], ['ready', 4, null]);
    const file = await dest.downloadLedgerExport(targetActor, exportId, exportScope);
    assert.equal(XLSX.read(file).Sheets[LEDGER_SHEET]['!ref'], 'A1:O5');
  } finally { await worker.close(); }
});
test('an allocated but uncommitted change head cannot make a reader skip its eventual commit', async () => {
  const oldHead = (await ledger.changes(identity, { ledgerEpoch: identity.ledgerEpoch })).head, blocker = await pool.connect(); let waiting;
  try {
    await blocker.query('BEGIN');
    await blocker.query("UPDATE member_profiles SET notes='pending',profile_version=profile_version+1 WHERE store_id=$1 AND id=$2", [identity.store_id, a.id]);
    const { rows: [head] } = await blocker.query('UPDATE store_change_heads SET head=head+1 WHERE store_id=$1 RETURNING head', [identity.store_id]);
    await blocker.query("INSERT INTO store_changes(store_id,cursor,entity_type,entity_id,change_type) VALUES($1,$2,'member',$3,'upsert')", [identity.store_id, head.head, a.id]);
    waiting = charge(b); waiting.catch(() => {});
    const during = await ledger.changes(identity, { ledgerEpoch: identity.ledgerEpoch, after: oldHead }); assert.equal(during.cursor, oldHead); assert.equal(during.head, oldHead); assert.equal(during.items.length, 0);
    await blocker.query('COMMIT'); await waiting; waiting = null;
    const after = await ledger.changes(identity, { ledgerEpoch: identity.ledgerEpoch, after: oldHead });
    assert.deepEqual(after.items.map(item => item.cursor), [1n, 2n, 3n].map(offset => String(BigInt(oldHead) + offset)));
    assert.equal(after.items[0].value.notes, 'pending'); assert.equal(after.cursor, after.head);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); if (waiting) await waiting; }
});

test('a task ID racing different member targets and types commits one immutable result', async () => {
  const id = randomUUID(), before = Number((await pool.query('SELECT count(*) AS n FROM application_task_receipts')).rows[0].n);
  const results = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => ledger.executeTask(identity, index % 2 ?
    { id, storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'member.create', data: { name: '并发创建' + index } } :
    { id, storeId: identity.store_id, ledgerEpoch: identity.ledgerEpoch, type: 'member.update', memberId: index % 4 ? a.id : b.id, data: { name: '并发编辑' + index, expectedVersion: '0' } })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'TASK_CONFLICT'));
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM application_task_receipts')).rows[0].n), before + 1);
  assert.deepEqual((await ledger.getTask(identity, id, { ledgerEpoch: identity.ledgerEpoch })).result, results.find(result => result.status === 'fulfilled').value);
});

test('real PostgreSQL streaming snapshot permits a concurrent financial commit and excludes that later state', async () => {
  const lines = []; let completed;
  const exported = await ledger.exportArchive(identity, { write: async line => {
    lines.push(line); if (lines.length === 1) completed = await deadline(charge(a), 3000);
  } });
  assert.equal(completed.balanceAfterCents, '1'); assert.equal(exported.entryCount, 0);
  const accounts = [], archive = await readRelationalArchive({ chunks: (async function* () { for (const line of lines) yield Buffer.from(line); })(),
    tables: PG_BACKUP_TABLES, engine: 'postgres', schemaVersion: 2, storeId: identity.store_id, hash: digest, validateRow: validatePostgresRow,
    onRows: async (table, rows) => { if (table === 'member_accounts') accounts.push(...rows); } });
  assert.equal(archive.rowCounts.ledger_entries, 0); assert.equal(accounts.find(row => row.member_id === a.id).balance_cents, '0');
  assert.equal((await ledger.getMember(identity, a.id)).balanceCents, '1');
});

test('real PostgreSQL streaming holds authorization locks only until its bounded transaction finishes', async () => {
  let revoke, settled = false;
  try {
    let writes = 0;
    await ledger.exportArchive(identity, { write: async () => {
      if (++writes === 1) {
        revoke = pool.query('UPDATE sessions SET revoked=true WHERE id=$1', [identity.sessionId]).then(value => { settled = true; return value; }); revoke.catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(settled, false);
      }
    } });
    await deadline(revoke, 3000); assert.equal(settled, true); await assert.rejects(ledger.getBook(identity), { code: 'AUTH_REQUIRED' });
  } finally { if (revoke) await revoke; }
});
