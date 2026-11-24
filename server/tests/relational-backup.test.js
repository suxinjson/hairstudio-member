import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createService } from './helpers/licensed-service.js';
import { relationalTestDatabase } from './helpers/relational-database.js';
import { digest, hashPassword } from '../security.js';
import { canonicalJSON } from '../../src/canonical-json.js';
import { LICENSE_FEATURES } from '../../src/license-policy.js';
import { validatePostgresBackup } from '../relational-backup.js';
import { migrate, configureRuntimeRole, configureRecoveryRole, assertRuntimeRole, assertRecoveryRole } from '../database.js';
import { roleTestDatabase } from './helpers/role-database.js';
import { createApi } from '../http.js';
import { PG_BACKUP_TABLES } from '../relational-backup.js';
import { writeRelationalArchive } from '../../src/relational-archive.js';
import { archiveLifetime } from '../relational-archive.js';
import { finishArchiveUpload, relationalArchiveRoute, writeArchiveChunk } from '../relational-archive-http.js';
import { PassThrough, Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';

const password = 'Relational-Backup-2026!';
let source, target, original, destination, sourceActor, targetActor, backup;
const clone = value => JSON.parse(JSON.stringify(value));
const signed = value => { const { digest: _, ...payload } = value; return { ...payload, digest: digest(canonicalJSON(payload)) }; };
const task = (book, type, data, memberId) => ({ ...book, id: randomUUID(), type, ...(data ? { data } : {}), ...(memberId ? { memberId } : {}) });
const restoreRequest = async () => ({ id: randomUUID(), ledgerEpoch: (await destination.relational.getBook(targetActor)).ledgerEpoch, reviewedDigest: backup.digest, backup: clone(backup) });
async function login(service, username) { return service.authenticate((await service.login({ username, password, deviceId: randomUUID() }, '127.0.0.1')).accessToken); }
async function targetInit({ existingActor = false, pool = target.pool } = {}) {
  await pool.query('TRUNCATE stores,login_limits RESTART IDENTITY CASCADE');
  await pool.query("INSERT INTO stores(id,name) VALUES($1,'恢复目标')", [sourceActor.store_id]);
  const id = existingActor ? sourceActor.id : randomUUID();
  await pool.query("INSERT INTO users(id,store_id,username,display_name,password_hash,role) VALUES($1,$2,'target-owner','当前店主',$3,'owner')", [id, sourceActor.store_id, await hashPassword(password)]);
  await pool.query('INSERT INTO store_licenses(id,store_id,features,offline_hours,starts_at) VALUES($1,$2,$3,8760,$4)', [randomUUID(), sourceActor.store_id, JSON.stringify(LICENSE_FEATURES), '2000-01-01T00:00:00Z']);
  destination = createService(pool, { recoveryPool: pool }); targetActor = await login(destination, 'target-owner');
}
before(async () => { source = await relationalTestDatabase(); target = await relationalTestDatabase(); });
after(async () => { await source?.close(); await target?.close(); });
beforeEach(async () => {
  await source.pool.query('TRUNCATE stores,login_limits RESTART IDENTITY CASCADE');
  original = createService(source.pool); const owner = await original.createOwner({ username: 'source-owner', password });

  sourceActor = await login(original, 'source-owner'); const ledger = original.relational, book = await ledger.getBook(sourceActor);
  await ledger.importOpeningBalances(sourceActor, { ledgerEpoch: book.ledgerEpoch, batchId: 'source-opening-batch-2026', sourceDigest: 'a'.repeat(64), expectedCount: 2, members: [{ id: 'opening-debt', name: '期初欠款', balanceCents: '-100' }, { id: 'opening-zero', name: '期初零余额', balanceCents: '0' }] });
  await ledger.executeTask(sourceActor, task(book, 'configuration.update', { expectedVersion: '0', services: [{ id: 'cut', name: '剪发', priceCents: '100' }], rechargePlans: [], rechargeSettings: { giftEnabled: true, giftRateBasisPoints: 1000 } }));
  const created = await ledger.executeTask(sourceActor, task(book, 'member.create', { name: '新增会员', phone: '+001-123', tags: ['新客'] }));
  await ledger.executeTask(sourceActor, task(book, 'member.update', { name: '已改资料', phone: '+001-123', tags: ['常客'], expectedVersion: '0' }, created.id));
  const credit = { ...book, id: randomUUID(), type: 'recharge', memberId: created.id, expectedAccountVersion: '0', actualPayCents: '1000', giftCents: '100', payments: [{ method: '现金', amountCents: '900' }, { method: '微信', amountCents: '100' }] };
  await ledger.executeCommand(sourceActor, credit);
  const spend = { ...book, id: randomUUID(), type: 'consume', memberId: created.id, expectedAccountVersion: '1', configurationVersion: '1', amountCents: '200', items: [{ serviceId: 'cut', name: '剪发', unitPriceCents: '100', quantity: 2 }] };
  await ledger.executeCommand(sourceActor, spend);
  await ledger.executeCommand(sourceActor, { ...book, id: randomUUID(), type: 'reverse', memberId: created.id, expectedAccountVersion: '2', originalEntryId: spend.id });
  await ledger.executeTask(sourceActor, task(book, 'member.archive', {}, 'opening-zero'));
  // The backup must preserve SQL microseconds, not the millisecond JSON API.
  await source.pool.query("UPDATE member_profiles SET created_at=date_trunc('milliseconds',created_at)+interval '123 microseconds',updated_at=date_trunc('milliseconds',updated_at)+interval '123 microseconds' WHERE id='opening-debt'");
  backup = await ledger.exportBackup(sourceActor); await targetInit();
});

test('complete cloud restore preserves funds, snapshots, task results, audit identities and SQL microseconds; retry never overwrites later business', async () => {
  const request = await restoreRequest(), preview = await destination.relational.previewBackupRestore(targetActor, request);
  assert.equal(preview.memberCount, 3); assert.equal(preview.entryCount, 3); assert.equal(preview.historicalActorCount, 1);
  const result = await destination.relational.restoreBackup(targetActor, request);
  assert.notEqual(result.ledgerEpoch, backup.ledgerEpoch); assert.notEqual(result.ledgerEpoch, request.ledgerEpoch);
  assert.equal(result.targetEpoch, request.ledgerEpoch);
  const imported = await destination.relational.exportBackup(targetActor);
  for (const table of Object.keys(backup.tables).filter(table => !['ledger_restore_receipts', 'audit_events', 'actors'].includes(table))) assert.deepEqual(imported.tables[table], backup.tables[table], table);
  assert.deepEqual(imported.tables.actors.filter(row => row.id === sourceActor.id), backup.tables.actors);
  assert.deepEqual(imported.tables.audit_events.filter(row => row.event !== 'ledger_restored'), backup.tables.audit_events);
  assert.ok(imported.tables.member_profiles.find(row => row.id === 'opening-debt').created_at.endsWith('123Z'));
  const book = await destination.relational.getBook(targetActor), created = await destination.relational.executeTask(targetActor, task(book, 'member.create', { name: '恢复后的新交易' }));
  await destination.relational.executeCommand(targetActor, { ...book, id: randomUUID(), type: 'recharge', memberId: created.id, expectedAccountVersion: '0', actualPayCents: '1' });
  assert.deepEqual(await destination.relational.restoreBackup(targetActor, request), result);
  assert.deepEqual(await destination.relational.getRestore(targetActor, request.id, { ledgerEpoch: request.ledgerEpoch }), result);
  assert.equal((await destination.relational.getMember(targetActor, created.id)).balanceCents, '1');
  await assert.rejects(destination.relational.restoreBackup(targetActor, { ...request, ledgerEpoch: book.ledgerEpoch }), { code: 'RESTORE_TASK_CONFLICT' });
  await assert.rejects(destination.relational.restoreBackup(targetActor, { ...request, id: randomUUID(), ledgerEpoch: book.ledgerEpoch }), { code: 'RESTORE_NOT_EMPTY' });
  const later = await destination.relational.exportBackup(targetActor); assert.equal(later.tables.ledger_restore_receipts.length, 1);
  await targetInit(); const second = await destination.relational.restoreBackup(targetActor, { id: randomUUID(), ledgerEpoch: (await destination.relational.getBook(targetActor)).ledgerEpoch, reviewedDigest: later.digest, backup: later });
  assert.notEqual(second.ledgerEpoch, result.ledgerEpoch); assert.equal((await destination.relational.getMember(targetActor, created.id)).balanceCents, '1');
  assert.equal((await destination.relational.exportBackup(targetActor)).tables.ledger_restore_receipts.length, 2);
});

test('historical actors are frozen references, excluded from staff; existing same-store accounts keep all current security properties', async () => {
  const request = await restoreRequest(); await destination.relational.restoreBackup(targetActor, request);
  const history = (await target.pool.query('SELECT * FROM users WHERE id=$1', [sourceActor.id])).rows[0];
  assert.equal(history.active, false); assert.equal(history.historical_only, true); assert.equal(history.role, 'viewer');
  assert.equal(history.password_hash, '!restored-history-no-password'); assert.equal(history.username, '~history~' + sourceActor.id);
  assert.deepEqual((await destination.users(targetActor)).map(row => row.id), [targetActor.id]);
  await assert.rejects(destination.updateUser(targetActor, sourceActor.id, { role: 'owner', active: true }), { code: 'HISTORICAL_ACTOR' });
  await assert.rejects(target.pool.query('UPDATE users SET active=true WHERE id=$1', [sourceActor.id]), { code: '23514' });
  await assert.rejects(destination.login({ username: history.username, password, deviceId: randomUUID() }, '127.0.0.1'), { status: 401 });
  const serialized = JSON.stringify(backup); for (const secret of ['password_hash', 'access_hash', 'refresh_hash', 'features', 'offline_hours', 'accounts']) assert.equal(serialized.includes('"' + secret + '"'), false, secret);
  await targetInit({ existingActor: true }); const before = (await target.pool.query('SELECT * FROM users WHERE id=$1', [targetActor.id])).rows[0];
  await destination.relational.restoreBackup(targetActor, await restoreRequest());
  assert.deepEqual((await target.pool.query('SELECT * FROM users WHERE id=$1', [targetActor.id])).rows[0], before);
});

test('backup rejects damaged or recomputed inconsistent funds, tasks, identities, timestamps, sync watermarks and secret columns', async () => {
  const altered = clone(backup); altered.tables.member_accounts[0].balance_cents = '99'; assert.throws(() => validatePostgresBackup(altered, sourceActor.store_id), { code: 'BACKUP_INVALID' });
  const mutations = [
    b => { b.tables.member_accounts[0].balance_cents = '99'; }, b => { b.tables.actors = []; },
    b => { b.tables.ledger_command_receipts.pop(); }, b => { b.tables.application_task_receipts[0].result = '{}'; },
    b => { b.tables.ledger_entries[0].occurred_at = '2026-02-30T00:00:00.123456Z'; },
    b => { b.tables.member_profiles[0].phone_normalized = 'tampered'; }, b => { b.tables.store_changes.splice(0, 1); },
    b => { b.tables.store_change_heads[0].head = '99999999'; }, b => { b.tables.actors[0].password_hash = 'secret'; },
    b => { b.tables.audit_events = b.tables.audit_events.filter(row => !row.event.startsWith('ledger_')); },
    b => { b.tables.recharge_details[0].configuration_version = '999'; },
    b => { const r = b.tables.ledger_command_receipts[0], v = JSON.parse(r.result); v.cursor = '0'; r.result = JSON.stringify(v); }
  ];
  for (const mutate of mutations) { const b = clone(backup); mutate(b); assert.throws(() => validatePostgresBackup(signed(b), sourceActor.store_id)); }
  const request = await restoreRequest(); await assert.rejects(destination.relational.restoreBackup(targetActor, { ...request, reviewedDigest: 'b'.repeat(64) }), { code: 'BACKUP_INVALID' });
  assert.equal((await destination.relational.getBook(targetActor)).ledgerEpoch, request.ledgerEpoch);
  assert.equal((await target.pool.query('SELECT count(*)::int AS n FROM member_profiles')).rows[0].n, 0);
});

test('restore actor cross-store collision is rejected before business, epoch or auth changes', async () => {
  const otherStore = randomUUID(); await target.pool.query("INSERT INTO stores(id,name) VALUES($1,'其他门店')", [otherStore]);
  await target.pool.query("INSERT INTO users(id,store_id,username,display_name,password_hash,role) VALUES($1,$2,'collision','其他账号','invalid','viewer')", [sourceActor.id, otherStore]);
  const request = await restoreRequest(); await assert.rejects(destination.relational.restoreBackup(targetActor, request), { code: 'RESTORE_ACTOR_CONFLICT' });
  assert.equal((await destination.relational.getBook(targetActor)).ledgerEpoch, request.ledgerEpoch);
  assert.equal((await target.pool.query('SELECT count(*)::int AS n FROM member_profiles')).rows[0].n, 0);
});

test('restore faults roll back imported actors, all history, audit, receipt and epoch; original capture remains retryable', async () => {
  for (const failAt of ['INSERT INTO ledger_entries', 'UPDATE stores SET ledger_epoch', 'INSERT INTO audit_events', 'COMMIT']) {
    const request = await restoreRequest(); let armed = true;
    const faultyPool = { async connect() { const client = await target.pool.connect(); return { release: (...args) => client.release(...args), async query(sql, params) {
      if (armed && sql.startsWith(failAt)) { armed = false; throw new Error('injected restore fault'); } return client.query(sql, params);
    } }; } };
    const faulty = createService(target.pool, { recoveryPool: faultyPool });
    await assert.rejects(faulty.relational.restoreBackup(targetActor, request), /injected restore fault/);
    assert.equal((await destination.relational.getBook(targetActor)).ledgerEpoch, request.ledgerEpoch);
    for (const table of ['member_profiles', 'ledger_entries', 'ledger_restore_receipts']) assert.equal((await target.pool.query('SELECT count(*)::int AS n FROM ' + table)).rows[0].n, 0);
    assert.equal((await target.pool.query('SELECT count(*)::int AS n FROM users WHERE historical_only')).rows[0].n, 0);
  }
  const request = await restoreRequest(), expected = clone(request); const pending = destination.relational.restoreBackup(targetActor, request);
  request.backup.tables.member_accounts[0].balance_cents = '999'; request.id = randomUUID();
  assert.equal((await pending).taskId, expected.id);
  assert.deepEqual((await destination.relational.exportBackup(targetActor)).tables.member_accounts, backup.tables.member_accounts);
});

test('restricted recovery role restores a complete book, ordinary runtime cannot rotate or create restore receipts', async t => {
  const realPostgres = Boolean(process.env.MEMBER_RELATIONAL_TEST_DATABASE_URL);
  const fixture = realPostgres ? await roleTestDatabase() : null;
  if (fixture) t.after(fixture.close);
  const pool = fixture?.pool ?? target.pool;
  if (fixture) { await migrate(pool); await targetInit({ pool }); }
  const runtimePassword = fixture?.password() ?? 'a'.repeat(48);
  const recoveryPassword = fixture?.password() ?? 'b'.repeat(48);
  await configureRuntimeRole(pool, runtimePassword); await configureRecoveryRole(pool, recoveryPassword);
  await configureRecoveryRole(pool, recoveryPassword);
  const scopedPool = name => ({ async connect() { const client = await pool.connect(); await client.query('SET ROLE ' + name); return {
    query: (...args) => client.query(...args), release() { const result = client.query('RESET ROLE'); result.finally(() => client.release()); }
  }; }, async query(...args) { const client = await this.connect(); try { return await client.query(...args); } finally { client.release(); } } });
  const runtime = fixture ? fixture.connect('member_app', runtimePassword) : scopedPool('member_app');
  const recovery = fixture ? fixture.connect('member_recovery', recoveryPassword) : scopedPool('member_recovery');
  await assertRuntimeRole(runtime); await assertRecoveryRole(recovery);
  await assert.rejects(runtime.query('SELECT refresh_recovery_statistics()'), { code: '42501' });
  await recovery.query('SELECT refresh_recovery_statistics()');
  const { rows: [routine] } = await pool.query("SELECT prosecdef,pronargs,proconfig FROM pg_proc WHERE oid='refresh_recovery_statistics()'::regprocedure");
  assert.deepEqual(routine, { prosecdef: true, pronargs: 0, proconfig: ['search_path=pg_catalog'] });
  assert.equal((await recovery.query("SELECT has_table_privilege(current_user,'ledger_entries','MAINTAIN') AS allowed")).rows[0].allowed, false);
  await pool.query('REVOKE EXECUTE ON FUNCTION refresh_recovery_statistics() FROM member_recovery');
  await assert.rejects(assertRecoveryRole(recovery), /统计刷新权限/);
  await configureRecoveryRole(pool, recoveryPassword); await assertRecoveryRole(recovery);
  const service = createService(runtime, { recoveryPool: recovery }), request = await restoreRequest();
  await service.relational.restoreBackup(targetActor, request); const exported = await service.relational.exportBackup(targetActor); assert.equal(exported.tables.member_profiles.length, 3);
  for (const sql of ["UPDATE stores SET ledger_epoch=gen_random_uuid()", 'INSERT INTO ledger_restore_receipts SELECT * FROM ledger_restore_receipts', 'UPDATE users SET historical_only=false']) await assert.rejects(runtime.query(sql), { code: '42501' });
  for (const sql of ["UPDATE users SET active=true", "UPDATE sessions SET id=gen_random_uuid()", "UPDATE store_licenses SET id=gen_random_uuid()", "UPDATE app_devices SET device_id='forged'", "UPDATE stores SET id=gen_random_uuid()", "UPDATE store_recharge_settings SET version=version+1", 'DELETE FROM ledger_entries', "UPDATE ledger_entries SET remark='forged'", 'TRUNCATE ledger_restore_receipts', "UPDATE ledger_restore_receipts SET source_digest='forged'", 'CREATE TABLE forbidden_recovery(id int)', "UPDATE users SET password_hash='forged'"]) await assert.rejects(recovery.query(sql), { code: '42501' }, sql);
  await assert.rejects(recovery.query("INSERT INTO users(id,store_id,username,display_name,password_hash,role) VALUES($1,$2,'forged-login','forged','invalid','owner')", [randomUUID(), sourceActor.store_id]), { code: '42501' });
  await pool.query('GRANT UPDATE(remark) ON ledger_entries TO member_recovery');
  await assert.rejects(assertRecoveryRole(recovery), /越界列/);
  await configureRecoveryRole(pool, recoveryPassword); await assertRecoveryRole(recovery);
  await assert.rejects(recovery.query("UPDATE ledger_entries SET remark='forged'"), { code: '42501' });
  await pool.query('GRANT UPDATE(remark) ON ledger_entries TO member_app');
  await assert.rejects(assertRuntimeRole(runtime), /历史记录列/); await configureRuntimeRole(pool, runtimePassword); await assertRuntimeRole(runtime);
  await pool.query('GRANT INSERT ON sessions TO member_recovery');
  await assert.rejects(assertRecoveryRole(recovery)); await configureRecoveryRole(pool, recoveryPassword); await assertRecoveryRole(recovery);
  await targetInit({ pool }); const archive = await archiveFrom(), preview = await previewStream(archive, randomUUID(), service);
  await service.relational.restoreArchive(targetActor, streamRequest(preview, archive));
  let frames = 0; await service.relational.exportArchive(targetActor, { write: async () => { frames++; } }); assert.ok(frames > 20);
});

test('cloud backup keyset pages preserve more than 500 members, tags, openings and changes without truncation', async () => {
  await source.pool.query('TRUNCATE stores,login_limits RESTART IDENTITY CASCADE');
  const owner = await original.createOwner({ username: 'paged-source', password });
sourceActor = await login(original, 'paged-source');
  const book = await original.relational.getBook(sourceActor);
  await original.relational.importOpeningBalances(sourceActor, { ledgerEpoch: book.ledgerEpoch, batchId: 'source-paged-opening-2026', sourceDigest: 'd'.repeat(64), expectedCount: 501,
    members: Array.from({ length: 501 }, (_, i) => ({ id: 'paged-' + i, name: '分页合成' + i, tags: ['分页'], balanceCents: String(i - 250) })) });
  const pages = new Map(); const traced = { async connect() { const client = await source.pool.connect(); return { release: () => client.release(), async query(sql, params) {
    const result = await client.query(sql, params); if (/LIMIT (?:200|64)$/.test(sql)) assert.ok(result.rows.length <= 200); if (sql.endsWith('LIMIT 500')) { const table = / FROM ([a-z_]+) WHERE/.exec(sql)[1]; pages.set(table, (pages.get(table) ?? 0) + 1); assert.ok(result.rows.length <= 500); } return result;
  } }; } };
  backup = await createService(traced).relational.exportBackup(sourceActor);
  for (const table of ['member_profiles', 'member_tags', 'member_accounts', 'account_openings', 'store_changes']) assert.equal(pages.get(table), 2, table);
  await targetInit(); const restored = await destination.relational.restoreBackup(targetActor, await restoreRequest()); assert.equal(restored.memberCount, 501);
  const restoredBackup = await destination.relational.exportBackup(targetActor);
  for (const table of ['member_profiles', 'member_tags', 'member_accounts', 'account_openings', 'store_changes']) assert.deepEqual(restoredBackup.tables[table], backup.tables[table], table);
  const lines = [], summary = await createService(traced).relational.exportArchive(sourceActor, { write: async line => lines.push(line) }); assert.equal(summary.memberCount, 501);
  await targetInit(); const archive = { text: lines.join('') }, preview = await previewStream(archive); await destination.relational.restoreArchive(targetActor, streamRequest(preview, archive));
  assert.equal(Number((await target.pool.query('SELECT count(*) AS n FROM member_profiles')).rows[0].n), 501);
});

test('cloud configuration backup retains full large immutable task results beyond the generic 16 KiB text budget', async () => {
  const book = await original.relational.getBook(sourceActor), services = Array.from({ length: 500 }, (_, i) => ({ id: 'large-' + i, name: '完整配置快照'.repeat(15) + i, priceCents: String(i) }));
  await original.relational.executeTask(sourceActor, task(book, 'configuration.update', { expectedVersion: '1', services, rechargePlans: [], rechargeSettings: { giftEnabled: true, giftRateBasisPoints: 1000 } }));
  backup = await original.relational.exportBackup(sourceActor); assert.ok(backup.tables.application_task_receipts.some(row => row.result.length > 16384));
  await destination.relational.restoreBackup(targetActor, await restoreRequest());
  assert.deepEqual((await destination.relational.getConfiguration(targetActor)).services, services);
  const lines = []; await original.relational.exportArchive(sourceActor, { write: async line => lines.push(line) });
  await targetInit(); const archive = { text: lines.join('') }, preview = await previewStream(archive); await destination.relational.restoreArchive(targetActor, streamRequest(preview, archive));
  assert.deepEqual((await destination.relational.getConfiguration(targetActor)).services, services);
});

test('HTTP cloud backup requires current owner/licence/device and separate recovery credentials, supports response recovery', async t => {
  const service = createService(target.pool, { recoveryPool: target.pool }), session = await service.login({ username: 'target-owner', password, deviceId: targetActor.device_id }, '127.0.0.1');
  const server = createApi({ service, pool: target.pool }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = 'http://127.0.0.1:' + server.address().port, headers = { authorization: 'Bearer ' + session.accessToken, 'content-type': 'application/json' };
  assert.equal((await fetch(origin + '/api/v2/backup')).status, 401);
  const request = await restoreRequest();
  for (const path of ['/api/v2/backup/restore/preview', '/api/v2/backup/restore']) { const response = await fetch(origin + path, { method: 'POST', headers, body: JSON.stringify(request) }); assert.equal(response.status, 200, JSON.stringify(await response.clone().json())); }
  const receipt = await fetch(origin + '/api/v2/backup/restores/' + request.id + '?ledgerEpoch=' + request.ledgerEpoch, { headers }); assert.equal(receipt.status, 200);
  assert.equal((await receipt.json()).taskId, request.id); assert.equal((await fetch(origin + '/api/v2/backup', { headers })).status, 200);
  const noRecovery = createService(target.pool); await assert.rejects(noRecovery.relational.restoreBackup(targetActor, request), { code: 'RECOVERY_UNAVAILABLE' });
  await target.pool.query("UPDATE users SET role='viewer' WHERE id=$1", [targetActor.id]);
  await assert.rejects(service.relational.exportBackup(targetActor), { code: 'FORBIDDEN' });
  await target.pool.query("UPDATE users SET role='owner' WHERE id=$1", [targetActor.id]); await target.pool.query('UPDATE store_licenses SET features=$1 WHERE store_id=$2', [JSON.stringify(['core']), targetActor.store_id]);
  await assert.rejects(service.relational.restoreBackup(targetActor, request), { code: 'FEATURE_DISABLED' });
  await target.pool.query('UPDATE store_licenses SET features=$1 WHERE store_id=$2', [JSON.stringify(LICENSE_FEATURES), targetActor.store_id]); await target.pool.query('UPDATE app_devices SET active=false WHERE store_id=$1', [targetActor.store_id]);
  await assert.rejects(service.relational.restoreBackup(targetActor, request), { code: 'DEVICE_DISABLED' });
});

async function archiveFrom(tables = backup.tables, extra = {}) {
  const lines = [], header = { kind: 'header', format: 'member-relational-stream', formatVersion: 1, engine: 'postgres', schemaVersion: 2, storeId: backup.storeId, ledgerEpoch: backup.ledgerEpoch, exportedAt: backup.exportedAt, ...extra };
  const result = await writeRelationalArchive({ header, tables: PG_BACKUP_TABLES, hash: digest, validateRow() {}, write: async line => lines.push(line), readTable: async function* (table) { for (let at = 0; at < tables[table].length; at += 200) yield tables[table].slice(at, at + 200); } });
  return { ...result, text: lines.join('') };
}
async function* bytes(text, size = 127) { const buffer = Buffer.from(text); for (let at = 0; at < buffer.length; at += size) yield buffer.subarray(at, at + size); }
async function previewStream(archive, id = randomUUID(), service = destination) {
  const ledgerEpoch = (await destination.relational.getBook(targetActor)).ledgerEpoch;
  return service.relational.previewArchiveRestore(targetActor, { id, ledgerEpoch, chunks: bytes(archive.text) });
}
const streamRequest = (preview, archive) => ({ id: preview.taskId, ledgerEpoch: preview.targetEpoch, sourceEpoch: preview.sourceEpoch, reviewedDigest: preview.sourceDigest, chunks: bytes(archive.text) });

test('PG streaming archive validates numeric account versions across file and account pages', async () => {
  const ledger = original.relational, book = await ledger.getBook(sourceActor), memberId = 'opening-debt';
  for (let version = 0; version < 205; version++) {
    await ledger.executeCommand(sourceActor, { ...book, id: randomUUID(), type: 'recharge', memberId, expectedAccountVersion: String(version), actualPayCents: '7' });
  }
  const lines = [], exported = await ledger.exportArchive(sourceActor, { ...book, write: async line => lines.push(line) });
  const archive = { ...exported, text: lines.join('') }, preview = await previewStream(archive);
  assert.equal(preview.entryCount, 208);
  assert.equal(preview.sourceDigest, exported.digest);
  const writes = [], recoveryPool = { async connect() { const client = await target.pool.connect(); return {
    release: discard => client.release(discard), query(sql, params) {
      if (sql.startsWith('INSERT INTO ledger_entries(')) writes.push(params.length);
      return client.query(sql, params);
    }
  }; } };
  const restored = await createService(target.pool, { recoveryPool }).relational.restoreArchive(targetActor, streamRequest(preview, archive));
  assert.deepEqual(writes, [200, 8].map(rows => rows * PG_BACKUP_TABLES.ledger_entries.length));
  const member = await destination.relational.getMember(targetActor, memberId, { ledgerEpoch: restored.ledgerEpoch });
  assert.deepEqual([member.accountVersion, member.balanceCents], ['205', '1335']);
});

test('PG streaming snapshot, rollback-only preview and atomic restore preserve the full book and original retry after new funds', async () => {
  const lines = [], exported = await original.relational.exportArchive(sourceActor, { write: async line => lines.push(line) });
  const archive = { ...exported, text: lines.join('') }, preview = await previewStream(archive);
  assert.equal(preview.memberCount, 3); assert.equal(preview.entryCount, 3); assert.equal(preview.historicalActorCount, 1); assert.equal(preview.sourceDigest, exported.digest);
  assert.equal(Number((await target.pool.query('SELECT count(*) AS n FROM member_profiles')).rows[0].n), 0);
  assert.equal(Number((await target.pool.query("SELECT count(*) AS n FROM users WHERE historical_only=true")).rows[0].n), 0);
  assert.equal((await destination.relational.getBook(targetActor)).ledgerEpoch, preview.targetEpoch);
  const request = streamRequest(preview, archive), queued = { ...request }, restoring = destination.relational.restoreArchive(targetActor, queued);
  queued.reviewedDigest = 'b'.repeat(64); queued.ledgerEpoch = randomUUID(); const result = await restoring;
  const imported = await destination.relational.exportBackup(targetActor);
  for (const table of Object.keys(backup.tables).filter(table => !['ledger_restore_receipts', 'audit_events', 'actors'].includes(table))) assert.deepEqual(imported.tables[table], backup.tables[table], table);
  assert.ok(imported.tables.member_profiles.find(row => row.id === 'opening-debt').created_at.endsWith('123Z'));
  const book = await destination.relational.getBook(targetActor);
  await destination.relational.executeCommand(targetActor, { ...book, id: randomUUID(), type: 'recharge', memberId: 'opening-debt', expectedAccountVersion: '0', actualPayCents: '1' });
  const unread = { async *[Symbol.asyncIterator]() { throw new Error('completed retry must not read the file'); } };
  assert.deepEqual(await destination.relational.restoreArchive(targetActor, { ...request, chunks: unread }), result);
  assert.deepEqual(await destination.relational.getRestore(targetActor, request.id, { ledgerEpoch: request.ledgerEpoch }), result);
  assert.equal((await destination.relational.getMember(targetActor, 'opening-debt')).balanceCents, '-99');
  await assert.rejects(destination.relational.restoreArchive(targetActor, { ...request, sourceEpoch: randomUUID(), chunks: unread }), { code: 'RESTORE_TASK_CONFLICT' });
  const later = []; await destination.relational.exportArchive(targetActor, { write: async line => later.push(line) });
  await targetInit(); const nextArchive = { text: later.join('') }, nextPreview = await previewStream(nextArchive);
  await destination.relational.restoreArchive(targetActor, streamRequest(nextPreview, nextArchive));
  assert.equal((await destination.relational.getMember(targetActor, 'opening-debt')).balanceCents, '-99');
});

test('PG streaming rejects recomputed semantic corruption and rolls back every imported row and historical actor', async () => {
  const mutations = [
    t => { t.member_accounts[0].balance_cents = '99'; }, t => { t.actors = []; },
    t => { t.actors.push({ ...t.actors[0], id: randomUUID() }); t.actors.sort((a, b) => a.id.localeCompare(b.id)); },
    t => { t.ledger_command_receipts.pop(); }, t => { t.application_task_receipts[0].result = '{}'; },
    t => { t.member_profiles[0].phone_normalized = 'tampered'; }, t => { t.store_changes.splice(0, 1); },
    t => { t.store_change_heads[0].head = '99999999'; }, t => { t.actors[0].display_name = ' '; },
    t => { t.audit_events = t.audit_events.filter(row => !row.event.startsWith('ledger_')); },
    t => { t.recharge_details[0].configuration_version = '999'; },
    t => { const r = t.ledger_command_receipts[0], v = JSON.parse(r.result); v.cursor = '0'; r.result = JSON.stringify(v); },
    t => { const a = t.audit_events.find(row => row.event === 'ledger_recharge'), d = JSON.parse(a.details); d.memberId = 'opening-zero'; a.details = JSON.stringify(d); },
    t => { t.member_profiles[0].created_at = '2026-02-30T00:00:00.123456Z'; }
  ];
  for (const mutate of mutations) {
    const tables = clone(backup.tables); mutate(tables); const archive = await archiveFrom(tables);
    await assert.rejects(previewStream(archive));
    assert.equal(Number((await target.pool.query('SELECT count(*) AS n FROM member_profiles')).rows[0].n), 0);
    assert.equal(Number((await target.pool.query("SELECT count(*) AS n FROM users WHERE historical_only=true")).rows[0].n), 0);
  }
});

test('PG streaming requires an exact receipt and audit match for each entry even when the counts match', async () => {
  const { ledgerEpoch } = await destination.relational.getBook(targetActor);
  const wrongReceipt = clone(backup.tables);
  const receipt = wrongReceipt.ledger_command_receipts.pop(), commandId = 'zz-orphan-command-2026';
  const result = JSON.parse(receipt.result);
  wrongReceipt.ledger_command_receipts.push({ ...receipt, command_id: commandId, result: JSON.stringify({ ...result, commandId, entryId: commandId }) });
  await assert.rejects(previewStream(await archiveFrom(wrongReceipt)), /缺少资金原单回执/);

  const auditMismatch = clone(backup.tables);
  const recharge = auditMismatch.audit_events.find(row => row.event === 'ledger_recharge');
  const consume = auditMismatch.audit_events.find(row => row.event === 'ledger_consume');
  recharge.event = 'ledger_consume';
  await assert.rejects(previewStream(await archiveFrom(auditMismatch)), /资金核心审计缺失、重复或与原单不一致/);

  recharge.event = 'ledger_recharge';
  Object.assign(consume, { event: recharge.event, details: recharge.details });
  await assert.rejects(previewStream(await archiveFrom(auditMismatch)), /资金核心审计缺失、重复或与原单不一致/);
  assert.equal(Number((await target.pool.query('SELECT count(*) AS n FROM ledger_entries')).rows[0].n), 0);
  assert.equal((await destination.relational.getBook(targetActor)).ledgerEpoch, ledgerEpoch);
});

test('PG streaming rejects incomplete footer, changed chain, wrong engine and reviewed digest; aborts roll back', async () => {
  const archive = await archiveFrom(), footer = archive.text.lastIndexOf('{');
  for (const text of [archive.text.slice(0, footer), archive.text.slice(0, -1), archive.text + '\n', archive.text.replace('期初欠款', '篡改欠款')]) await assert.rejects(previewStream({ text }));
  await assert.rejects(previewStream(await archiveFrom(backup.tables, { engine: 'sqlite' })));
  const preview = await previewStream(archive), request = streamRequest(preview, archive);
  await assert.rejects(destination.relational.restoreArchive(targetActor, { ...request, reviewedDigest: 'b'.repeat(64) }), { code: 'BACKUP_INVALID' });
  const controller = new AbortController();
  const chunks = { async *[Symbol.asyncIterator]() { let n = 0; for await (const chunk of bytes(archive.text, 4096)) { if (++n === 3) controller.abort(); yield chunk; } } };
  await assert.rejects(destination.relational.restoreArchive(targetActor, { ...request, chunks, signal: controller.signal }), { code: 'ARCHIVE_ABORTED' });
  assert.equal(Number((await target.pool.query('SELECT count(*) AS n FROM member_profiles')).rows[0].n), 0);
  assert.equal((await destination.relational.getBook(targetActor)).ledgerEpoch, request.ledgerEpoch);
});

test('PG preview never reports success on rollback failure; unknown committed restore recovers by original receipt', async () => {
  const archive = await archiveFrom(); let rollbackFailed = false, discarded = false;
  const failing = { async connect() { const client = await target.pool.connect(); return {
    release(discard) { discarded ||= !!discard; client.release(discard); }, async query(sql, params) { if (sql === 'ROLLBACK' && !rollbackFailed) { rollbackFailed = true; throw new Error('injected rollback failure'); } return client.query(sql, params); }
  }; } };
  await assert.rejects(previewStream(archive, randomUUID(), createService(target.pool, { recoveryPool: failing })), /injected rollback failure/); assert.equal(discarded, true);
  assert.equal(Number((await target.pool.query('SELECT count(*) AS n FROM member_profiles')).rows[0].n), 0);
  const preview = await previewStream(archive), request = streamRequest(preview, archive); let lost = false;
  const ambiguous = { async connect() { const client = await target.pool.connect(); return {
    release: discard => client.release(discard), async query(sql, params) { const result = await client.query(sql, params); if (sql === 'COMMIT' && !lost) { lost = true; throw new Error('lost commit acknowledgement'); } return result; }
  }; } };
  await assert.rejects(createService(target.pool, { recoveryPool: ambiguous }).relational.restoreArchive(targetActor, request), /lost commit acknowledgement/);
  const receipt = await destination.relational.getRestore(targetActor, request.id, { ledgerEpoch: request.ledgerEpoch });
  const book = await destination.relational.getBook(targetActor); await destination.relational.executeCommand(targetActor, { ...book, id: randomUUID(), type: 'recharge', memberId: 'opening-debt', expectedAccountVersion: '0', actualPayCents: '1' });
  assert.deepEqual(await destination.relational.restoreArchive(targetActor, { ...request, chunks: { async *[Symbol.asyncIterator]() { throw new Error('unread'); } } }), receipt);
  assert.equal((await destination.relational.getMember(targetActor, 'opening-debt')).balanceCents, '-99');
});

test('PG streaming honors sink backpressure and abort, and rejects non-owner or unconfigured recovery', async () => {
  let writes = 0, pending = false; const stop = new AbortController();
  await assert.rejects(original.relational.exportArchive(sourceActor, { signal: stop.signal, write: async () => { assert.equal(pending, false); pending = true; await new Promise(resolve => setTimeout(resolve, 1)); pending = false; if (++writes === 3) stop.abort(); } }), { code: 'ARCHIVE_ABORTED' });
  assert.equal(writes, 3); assert.equal((await original.relational.getBook(sourceActor)).ledgerEpoch, backup.ledgerEpoch);
  await assert.rejects(original.relational.exportArchive(sourceActor, { write: async () => { throw new Error('sink failed'); } }), /sink failed/);
  const archive = await archiveFrom(), ledgerEpoch = (await destination.relational.getBook(targetActor)).ledgerEpoch;
  await assert.rejects(createService(target.pool).relational.previewArchiveRestore(targetActor, { id: randomUUID(), ledgerEpoch, chunks: bytes(archive.text) }), { code: 'RECOVERY_UNAVAILABLE' });
  await source.pool.query("UPDATE users SET role='viewer' WHERE id=$1", [sourceActor.id]);
  await assert.rejects(original.relational.exportArchive(sourceActor, { write: async () => {} }), { code: 'FORBIDDEN' });
});

test('PG archive I/O idle deadline and HTTP write callback bound outstanding work', async () => {
  const life = archiveLifetime(undefined, { totalMs: 500, idleMs: 15 }), held = setTimeout(() => {}, 1000);
  try { await assert.rejects(life.wait(() => new Promise(() => {})), { code: 'ARCHIVE_ABORTED' }); } finally { life.close(); clearTimeout(held); }
  const response = new EventEmitter(); response.write = (_line, callback) => { response.callback = callback; return false; };
  let completed = false; const written = writeArchiveChunk(response, 'frame\n').then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false); response.callback(); await written; assert.equal(response.listenerCount('close'), 0);
  const failed = writeArchiveChunk(response, 'frame\n'); response.emit('close'); await assert.rejects(failed, { code: 'ARCHIVE_ABORTED' });
});

test('completed HTTP restore retry consumes the remaining upload before returning its original receipt', async () => {
  const request = new PassThrough(); request.method = 'POST'; request.headers = { 'content-type': 'application/x-ndjson' };
  const response = new EventEmitter(), headers = new Map(); response.setHeader = (name, value) => headers.set(name, value);
  const receipt = { taskId: randomUUID(), ledgerEpoch: randomUUID() };
  let returned, queried; const query = new Promise(resolve => { queried = resolve; });
  const result = relationalArchiveRoute({ ledger: { async restoreArchive() { queried(); return receipt; } }, identity: { id: randomUUID() },
    request, response, url: new URL('http://internal/api/v2/backup/archive/restore'), guard: { take() {} } }).then(value => { returned = value; return value; });
  try {
    request.write(Buffer.alloc(64 * 1024, 'a')); await query; await new Promise(resolve => setImmediate(resolve));
    assert.equal(returned, undefined, 'receipt must wait for HTTP upload completion to avoid a socket reset');
    request.end(Buffer.alloc(64 * 1024, 'b'));
    assert.deepEqual(await result, { status: 200, value: receipt });
    assert.equal(headers.get('Connection'), undefined); assert.equal(request.readableEnded, true);
  } finally { request.destroy(); }
});

test('duplicate archive upload remains bounded by idle, total and byte limits without buffering the file', async () => {
  const stalled = new PassThrough(), held = setTimeout(() => {}, 1000);
  try { await assert.rejects(finishArchiveUpload(stalled, undefined, { totalMs: 500, idleMs: 15 }), { code: 'ARCHIVE_ABORTED' }); }
  finally { stalled.destroy(); clearTimeout(held); }
  const dribbling = new PassThrough(), tick = setInterval(() => dribbling.write(Buffer.from('x')), 5);
  try { await assert.rejects(finishArchiveUpload(dribbling, undefined, { totalMs: 35, idleMs: 500 }), { code: 'ARCHIVE_ABORTED' }); }
  finally { clearInterval(tick); dribbling.destroy(); }
  const stopped = new AbortController(); stopped.abort();
  const cancelled = new PassThrough();
  try { await assert.rejects(finishArchiveUpload(cancelled, stopped.signal), { code: 'ARCHIVE_ABORTED' }); }
  finally { cancelled.destroy(); }
  const block = Buffer.alloc(1024 * 1024);
  const oversized = Readable.from((function* () { for (let n = 0; n < 8193; n++) yield block; })());
  try { await assert.rejects(finishArchiveUpload(oversized), { code: 'ARCHIVE_CAPACITY' }); }
  finally { oversized.destroy(); }
});

test('HTTP streams an authenticated archive and preview/restore without JSON buffering; exact completed upload retries query the receipt', async t => {
  const start = async (service, pool, actor, username) => {
    const session = await service.login({ username, password, deviceId: actor.device_id }, '127.0.0.1'), server = createApi({ service, pool });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    return { origin: 'http://127.0.0.1:' + server.address().port, headers: { authorization: 'Bearer ' + session.accessToken } };
  };
  const from = await start(original, source.pool, sourceActor, 'source-owner'), to = await start(destination, target.pool, targetActor, 'target-owner');
  assert.equal((await fetch(from.origin + '/api/v2/backup/archive')).status, 401);
  const response = await fetch(from.origin + '/api/v2/backup/archive', { headers: from.headers }); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /application\/x-ndjson/); assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const text = await response.text(), id = randomUUID(), ledgerEpoch = (await destination.relational.getBook(targetActor)).ledgerEpoch;
  const headers = { ...to.headers, 'content-type': 'application/x-ndjson; charset=utf-8' }, params = new URLSearchParams({ id, ledgerEpoch });
  const upload = (suffix, query = params, body = text, override = headers) => fetch(to.origin + '/api/v2/backup/archive/restore' + suffix + '?' + query, { method: 'POST', headers: override, body });
  assert.equal((await upload('/preview', params, text, { ...to.headers, 'content-type': 'application/json' })).status, 415);
  const checked = await upload('/preview'); assert.equal(checked.status, 200, JSON.stringify(await checked.clone().json())); const preview = await checked.json();
  params.set('sourceEpoch', preview.sourceEpoch); params.set('reviewedDigest', preview.sourceDigest);
  const restored = await upload(''); assert.equal(restored.status, 200, JSON.stringify(await restored.clone().json())); const receipt = await restored.json();
  const retry = await upload('', params, 'deliberately not an archive'); assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), receipt);
  const delayed = Readable.from((async function* () { yield Buffer.from('duplicate upload'); await new Promise(resolve => setTimeout(resolve, 25)); yield Buffer.alloc(256 * 1024, 'x'); })());
  const streamingRetry = await fetch(to.origin + '/api/v2/backup/archive/restore?' + params, { method: 'POST', headers, body: delayed, duplex: 'half' });
  assert.equal(streamingRetry.status, 200); assert.deepEqual(await streamingRetry.json(), receipt);
  const duplicate = new URLSearchParams({ id, ledgerEpoch }); duplicate.append('id', id); assert.equal((await upload('/preview', duplicate)).status, 400);
});

test('PG streaming preserves durable batches and rejects recomputed captured request tampering', async () => {
  const scope = { ...await original.relational.getBook(sourceActor), actorId: sourceActor.id, deviceId: sourceActor.device_id }, id = randomUUID();
  const batch = { ...scope, id, items: Array.from({ length: 3 }, (_, i) => ({ id: randomUUID(), type: 'member.create', data: { name: '流式批次' + i, tags: ['乙', '甲'] } })) };
  await original.relational.captureBatch(sourceActor, batch);
  await original.relational.controlBatch(sourceActor, { ...scope, id, state: 'active', expectedVersion: '0' });
  await original.relational.executeBatchItem(sourceActor, { ...scope, id }, batch.items[0].id);
  await original.relational.controlBatch(sourceActor, { ...scope, id, state: 'paused', expectedVersion: '1' });
  const lines = []; await original.relational.exportArchive(sourceActor, { write: async line => lines.push(line) }); const archive = { text: lines.join('') };
  const preview = await previewStream(archive); await destination.relational.restoreArchive(targetActor, streamRequest(preview, archive));
  const imported = await destination.relational.exportBackup(targetActor), prior = await original.relational.exportBackup(sourceActor);
  for (const name of ['application_batches', 'application_batch_items', 'application_batch_tags', 'application_batch_controls']) assert.deepEqual(imported.tables[name], prior.tables[name]);
  await targetInit(); prior.tables.application_batch_items[0].name = '重新计算摘要仍需拒绝';
  await assert.rejects(previewStream(await archiveFrom(prior.tables)), { code: 'BACKUP_INVALID' });
  assert.equal(Number((await target.pool.query('SELECT count(*) AS n FROM application_batches')).rows[0].n), 0);
});

test('PG streaming notices session expiration after a frame and releases its snapshot', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); let written = 0;
  try {
    await assert.rejects(original.relational.exportArchive(sourceActor, { write: async () => { if (++written === 1) t.mock.timers.tick(31 * 24 * 60 * 60 * 1000); } }), { code: 'AUTH_REQUIRED' });
    assert.equal(written, 1);
  } finally { t.mock.timers.reset(); }
  assert.equal((await original.relational.getBook(sourceActor)).ledgerEpoch, backup.ledgerEpoch);
});

test('HTTP upload disconnect rolls back inserted historical actors and releases recovery locks', async t => {
  const archive = await archiveFrom(), ledgerEpoch = (await destination.relational.getBook(targetActor)).ledgerEpoch;
  let inserted; const received = new Promise(resolve => { inserted = resolve; });
  const recovery = { async connect() { const client = await target.pool.connect(); return {
    release: discard => client.release(discard), async query(sql, params) { const value = await client.query(sql, params); if (sql.startsWith('INSERT INTO users')) inserted(); return value; }
  }; } };
  const service = createService(target.pool, { recoveryPool: recovery }), session = await service.login({ username: 'target-owner', password, deviceId: targetActor.device_id }, '127.0.0.1');
  const server = createApi({ service, pool: target.pool }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const params = new URLSearchParams({ id: randomUUID(), ledgerEpoch }), request = httpRequest('http://127.0.0.1:' + server.address().port + '/api/v2/backup/archive/restore/preview?' + params, { method: 'POST', headers: { authorization: 'Bearer ' + session.accessToken, 'content-type': 'application/x-ndjson' } });
  request.on('error', () => {}); let timer;
  try {
    request.write(archive.text.split('\n').slice(0, 2).join('\n') + '\n');
    await Promise.race([received, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('upload never reached actor insertion')), 3000); })]);
  } finally { clearTimeout(timer); request.destroy(); }
  // The serialized local pool cannot answer until the recovery transaction has
  // ended. Real PG is also checked through a fresh authorized empty-target call.
  let remaining;
  for (let n = 0; n < 30; n++) { remaining = Number((await target.pool.query("SELECT count(*) AS n FROM users WHERE historical_only=true")).rows[0].n); if (!remaining) break; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(remaining, 0); assert.equal((await destination.relational.getBook(targetActor)).ledgerEpoch, ledgerEpoch);
  assert.equal((await previewStream(archive)).entryCount, 3);
});
