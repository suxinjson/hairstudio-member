import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, copyFile, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../http.js';
import { hashPassword } from '../security.js';
import { createService } from './helpers/licensed-service.js';
import { relationalTestDatabase } from './helpers/relational-database.js';
import { buildOpeningProjection } from '../../tools/relational-import.mjs';
import { openNodeSqlite } from '../../tools/sqlite-node-driver.mjs';
import { createRelationalSqlite } from '../../src/relational-sqlite.js';
import { createRelationalRemote } from '../../src/relational-remote.js';
import { createRelationalSync } from '../../src/relational-sync.js';
import { LICENSE_FEATURES } from '../../src/license-policy.js';

const password = 'Synthetic-Cutover-2026!';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function expose(t, database, service, username, deviceId = randomUUID()) {
  const server = createApi({ service, pool: database.pool });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const root = 'http://127.0.0.1:' + server.address().port;
  async function raw(path, options = {}) {
    const response = await fetch(root + path, { signal: AbortSignal.timeout(30000), ...options,
      headers: { ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers, ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
    if (!response.ok) { const error = await response.json(); throw Object.assign(new Error(error.error), { status: response.status, code: error.code }); }
    return response;
  }
  const request = async (path, options) => (await raw(path, options)).json();
  const post = (path, value) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  let token;
  const session = await post('/api/v1/auth/login', { username, password, deviceId }); token = session.accessToken;
  return { deviceId, actorId: session.user.id, raw, post, request, remote: createRelationalRemote({ request }) };
}
async function walk(list) {
  const all = new Map(); let cursor;
  do {
    const page = await list({ cursor, limit: 17 });
    for (const { id, name, phone, notes, tags, balanceCents } of page.items) {
      assert.ok(!all.has(id), 'pagination repeated a member');
      all.set(id, { name, phone, notes, tags, balanceCents });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

test('cutover rehearsal: 91 synthetic openings, reopened SQLite, exact retry, reversal, disk archive restore and old-device fence', { timeout: 90000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'member-cutover-rehearsal-'));
  let repository;
  t.after(async () => { await repository?.close(); await rm(directory, { recursive: true, force: true }); });
  const original = await relationalTestDatabase(); t.after(original.close);
  const recovery = await relationalTestDatabase(); t.after(recovery.close);
  const store = createService(original.pool), recovered = createService(recovery.pool, { recoveryPool: recovery.pool });
  const { storeId } = await store.createOwner({ username: 'drill-source', password });
  const user = await expose(t, original, store, 'drill-source'), book = await user.remote.getBook(), { ledgerEpoch } = book;
  const originalRows = Array.from({ length: 91 }, (_, i) => ({ id: 'old-' + String(i).padStart(3, '0'),
    name: '合成会员 ' + (i < 2 ? 0 : i), phone: i < 2 ? '001-002' : '', notes: i === 5 ? '最近来店回归备注' : '',
    tag: '原标签', balance: (i - 1) * 137, isArchived: false, total_recharge: 90000 }));
  const legacy = join(directory, 'legacy-final.json'), independent = join(directory, 'independent-legacy-copy.json');
  await writeFile(legacy, JSON.stringify({ data: { members: originalRows, ledgers: [{ ignored: true }] } }), { flag: 'wx' });
  await copyFile(legacy, independent);
  const bytes = await readFile(independent);
  assert.equal(hash(bytes), hash(await readFile(legacy)));
  const { projection, summary } = buildOpeningProjection(bytes);
  const input = { ...projection, ledgerEpoch };
  assert.deepEqual([summary.memberCount, summary.negativeBalanceCount, summary.zeroBalanceCount, summary.duplicatePhoneGroups], [91, 1, 1, 1]);
  const preview = await user.post('/api/v2/import/openings/preview', input);
  assert.equal(preview.payloadDigest, summary.payloadDigest);
  assert.equal(preview.sourceDigest, hash(bytes));
  assert.equal((await user.remote.listMembers({ ledgerEpoch })).items.length, 0);
  assert.equal((await user.post('/api/v2/import/openings', input)).alreadyImported, false);
  assert.equal((await user.post('/api/v2/import/openings', input)).alreadyImported, true);

  const expected = new Map(originalRows.map(row => [row.id, { name: row.name, phone: row.phone, notes: row.notes, tags: ['原标签'], balanceCents: String(row.balance) }]));
  assert.deepEqual(await walk(query => user.remote.listMembers({ ...query, ledgerEpoch })), expected);
  const reportInput = { from: '2020-01-01T00:00:00.000Z', to: '2020-01-02T00:00:00.000Z', offsetMinutes: 480 };
  const report = await user.remote.reportBusiness({ ...reportInput, ledgerEpoch });
  assert.equal(report.summary.newActiveMemberCount, 0);
  assert.equal((await user.remote.listLedger({ ledgerEpoch })).items.length, 0);

  const path = join(directory, 'replica.sqlite');
  async function reopen() {
    await repository?.close();
    repository = createRelationalSqlite({ driver: openNodeSqlite(path), storeId, ledgerEpoch, mode: 'cloud',
      authorize: async () => ({ storeId, id: user.actorId, role: 'owner', deviceId: user.deviceId, features: LICENSE_FEATURES }) });
    await repository.init();
  }
  const sync = remote => createRelationalSync({ repository, remote }).sync();
  await reopen(); assert.equal((await sync(user.remote)).status, 'confirmed');
  await reopen(); assert.deepEqual(await walk(query => repository.listMembers(query)), expected);

  const sale = (memberId, type, accountVersion, data) => ({ ...book, actorId: user.actorId, deviceId: user.deviceId, id: randomUUID(), memberId, type,
    expectedAccountVersion: String(accountVersion), expectedProfileVersion: '0', ...(type === 'reverse' ? {} : { configurationVersion: '0' }), ...data });
  const charge = sale('old-002', 'recharge', 0, { actualPayCents: '100' });
  await repository.executeCommand(charge);
  const dropped = { ...user.remote, async executeCommand(command) { assert.deepEqual(command, charge); await user.remote.executeCommand(command); throw new Error('reply deliberately lost'); } };
  assert.equal((await sync(dropped)).status, 'pending');
  await reopen(); assert.deepEqual((await repository.pendingCommands()).map(item => item.command), [charge]);
  assert.equal((await sync(user.remote)).status, 'confirmed');
  assert.equal((await user.remote.listLedger({ memberId: charge.memberId, ledgerEpoch })).items.length, 1);

  const visit = sale('old-005', 'consume', 0, { amountCents: '40' });
  await user.remote.executeCommand(visit);
  const spent = sale('old-002', 'consume', 1, { amountCents: '27' });
  await repository.executeCommand(spent); assert.equal((await sync(user.remote)).status, 'confirmed');
  const undo = sale(spent.memberId, 'reverse', 2, { originalEntryId: spent.id });
  await user.remote.executeCommand(undo); assert.equal((await sync(user.remote)).status, 'confirmed');
  expected.get(charge.memberId).balanceCents = '237'; expected.get(visit.memberId).balanceCents = '508';
  assert.deepEqual(await walk(query => repository.listMembers(query)), expected);
  for (const list of [query => repository.listMembers(query), query => user.remote.listMembers({ ...query, ledgerEpoch })]) {
    assert.equal((await list({ balance: 'recent' })).items[0].id, visit.memberId);
    assert.deepEqual((await list({ search: '回归备注' })).items.map(row => row.id), [visit.memberId]);
  }
  await assert.rejects(user.post('/api/v2/import/openings', { ...input, batchId: randomUUID(), sourceDigest: '0'.repeat(64) }), { code: 'OPENING_NOT_EMPTY' });

  const archive = join(directory, 'relational.ndjson');
  const download = await user.raw('/api/v2/backup/archive');
  assert.match(download.headers.get('content-type'), /ndjson/);
  await pipeline(Readable.fromWeb(download.body), createWriteStream(archive, { flags: 'wx' }));
  const backup = await readFile(archive);
  assert.ok(backup.length > 0);
  await recovery.pool.query("INSERT INTO stores(id,name) VALUES($1,'合成恢复门店')", [storeId]);
  await recovery.pool.query("INSERT INTO users(id,store_id,username,display_name,password_hash,role) VALUES($1,$2,'drill-target','合成恢复账号',$3,'owner')", [randomUUID(), storeId, await hashPassword(password)]);
  await recovery.pool.query('INSERT INTO store_licenses(id,store_id,features,offline_hours,starts_at) VALUES($1,$2,$3,8760,$4)', [randomUUID(), storeId, JSON.stringify(LICENSE_FEATURES), '2000-01-01T00:00:00Z']);
  const target = await expose(t, recovery, recovered, 'drill-target');
  const targetBook = await target.remote.getBook(), restoreId = randomUUID();
  const pathFor = (suffix, query) => '/api/v2/backup/archive/restore' + suffix + '?' + new URLSearchParams(query);
  const upload = { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body: backup };
  const lookup = { id: restoreId, ledgerEpoch: targetBook.ledgerEpoch };
  const check = await target.request(pathFor('/preview', lookup), upload);
  assert.deepEqual([check.memberCount, check.entryCount, check.sourceEpoch, check.byteLength], [91, 4, ledgerEpoch, backup.length]);
  assert.equal((await target.remote.listMembers({ ledgerEpoch: targetBook.ledgerEpoch })).items.length, 0);
  const restorePath = pathFor('', { ...lookup, sourceEpoch: check.sourceEpoch, reviewedDigest: check.sourceDigest });
  const restored = await target.request(restorePath, upload);
  assert.notEqual(restored.ledgerEpoch, targetBook.ledgerEpoch); assert.notEqual(restored.ledgerEpoch, ledgerEpoch);
  assert.deepEqual(await walk(query => target.remote.listMembers({ ...query, ledgerEpoch: restored.ledgerEpoch })), expected);
  const afterRestore = { ...sale(charge.memberId, 'recharge', 3, { actualPayCents: '5' }), actorId: target.actorId, deviceId: target.deviceId, ledgerEpoch: restored.ledgerEpoch };
  assert.equal((await target.remote.executeCommand(afterRestore)).balanceAfterCents, '242');
  assert.deepEqual(await target.request(restorePath, upload), restored);
  assert.equal((await target.remote.getMember(charge.memberId, { ledgerEpoch: restored.ledgerEpoch })).balanceCents, '242');
  await assert.rejects(target.remote.executeCommand({ ...afterRestore, id: randomUUID(), ledgerEpoch }), { code: 'LEDGER_EPOCH_MISMATCH' });
  const queued = sale(visit.memberId, 'recharge', 1, { actualPayCents: '1' }); await repository.executeCommand(queued);
  let writes = 0;
  assert.deepEqual(await sync({ ...target.remote, executeCommand: () => { writes++; assert.fail('restored book must reject old outbox before send'); } }),
    { status: 'blocked', errorCode: 'LEDGER_EPOCH_MISMATCH' });
  assert.equal(writes, 0);
  assert.deepEqual((await repository.pendingCommands()).map(row => row.command), [queued]);
  assert.equal((await target.remote.getMember(visit.memberId, { ledgerEpoch: restored.ledgerEpoch })).balanceCents, '508');
});
