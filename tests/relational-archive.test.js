import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJSON } from '../src/canonical-json.js';
import { ARCHIVE_LIMITS, readRelationalArchive, writeRelationalArchive } from '../src/relational-archive.js';
import { createRelationalSqlite, sha256 } from '../src/relational-sqlite.js';
import { openNodeSqlite } from '../tools/sqlite-node-driver.mjs';
import { LICENSE_FEATURES } from '../src/license-policy.js';

const storeId = 'archive-store', actorId = 'archive-owner', deviceId = 'archive-device-20261119', ledgerEpoch = '00000000-0000-4000-8000-000000000001';
const header = () => ({ kind: 'header', format: 'member-relational-stream', formatVersion: 1, engine: 'sqlite', schemaVersion: 6, storeId, ledgerEpoch, exportedAt: '2026-11-19T01:00:00.000Z' });
async function* chunks(content, size = 817) {
  const bytes = new TextEncoder().encode(content);
  for (let at = 0; at < bytes.length; at += size) yield bytes.slice(at, at + size);
}
async function codecFixture() {
  const tables = { first: ['store_id', 'value'], empty: ['store_id'] }, lines = [];
  const validateRow = (name, row, store) => assert.equal(row.store_id, store);
  const result = await writeRelationalArchive({ header: header(), tables, hash: sha256, validateRow, write: async line => lines.push(line),
    readTable: async function* (table) { if (table === 'first') yield Array.from({ length: 405 }, (_, i) => ({ store_id: storeId, value: '合成🦊' + i })); } });
  return { content: lines.join(''), result, read: (content, options = {}) => readRelationalArchive({ chunks: chunks(content), tables, engine: 'sqlite', schemaVersion: 6, storeId, hash: sha256, validateRow, ...options }) };
}
async function rechain(content, mutate) {
  const records = content.trimEnd().split('\n').map(line => JSON.parse(line)); mutate(records);
  let prior = await sha256(canonicalJSON(records[0]));
  for (const record of records.slice(1)) { delete record.hash; record.priorHash = prior; record.hash = await sha256(canonicalJSON(record)); prior = record.hash; }
  return records.map(row => canonicalJSON(row) + '\n').join('');
}

test('stream codec preserves Unicode split at every byte, bounded frames, empty tables and backpressure', async () => {
  const f = await codecFixture(), received = [];
  const restored = await f.read(f.content, { chunks: chunks(f.content, 1), onRows: async (table, rows) => { assert.ok(rows.length <= 200); received.push(...rows); } });
  assert.equal(restored.digest, f.result.digest); assert.equal(restored.byteLength, f.result.byteLength);
  assert.equal(received.length, 405); assert.equal(received.at(-1).value, '合成🦊404');
  assert.ok(restored.peakFrameBytes <= ARCHIVE_LIMITS.frameBytes); assert.deepEqual(restored.rowCounts, { first: 405, empty: 0 });
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; }); let writes = 0;
  const writing = writeRelationalArchive({ header: header(), tables: {}, hash: sha256, validateRow() {}, readTable() {}, write: async () => { writes++; entered(); await gate; } });
  await started; assert.equal(writes, 1); release(); await writing; assert.equal(writes, 2);
});

test('stream codec rejects damage, truncation, duplicates, wrong order/counts, trailing data and invalid UTF-8', async () => {
  const f = await codecFixture();
  for (const content of [f.content.slice(0, -1), f.content.slice(0, f.content.lastIndexOf('\n', f.content.length - 2) + 1), f.content + '\n', f.content.replace('合成', '篡改'),
    f.content.replace('"kind":"header"', '"kind":"header","kind":"header"'), f.content.replace('"kind":"header"', '"kind": "header"'),
    await rechain(f.content, rows => rows.find(r => r.kind === 'rows').table = 'empty'), await rechain(f.content, rows => rows.find(r => r.kind === 'tableEnd').rowCount++),
    await rechain(f.content, rows => rows.at(-1).rowCount++), await rechain(f.content, rows => rows[1].sequence++), await rechain(f.content, rows => rows.splice(-2, 1)),
    await rechain(f.content, rows => rows[0].schemaVersion = 5)]) await assert.rejects(f.read(content));
  await assert.rejects(f.read('', { chunks: (async function* () { yield new Uint8Array([0xff, 10]); })() }), /UTF-8/);
  await assert.rejects(f.read('', { chunks: (async function* () { yield new Uint8Array([0xe4]); })() }), /UTF-8/);
  await assert.rejects(f.read('', { chunks: (async function* () { yield new Uint8Array(ARCHIVE_LIMITS.chunkBytes + 1); })() }));
  await assert.rejects(f.read('', { chunks: chunks('x'.repeat(ARCHIVE_LIMITS.frameBytes)) }), { code: 'ARCHIVE_CAPACITY' });
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'member-archive-')), path = join(directory, 'book.sqlite');
  let user = { storeId, id: actorId, deviceId, role: 'owner', features: LICENSE_FEATURES }, fault, snapshotCount = 0, maxRows = 0, maxBindings = 0, db, driver;
  function wrap(raw, isSnapshot = false) {
    const all = raw.all, run = raw.run, exec = raw.exec, close = raw.close;
    raw.all = (sql, p = []) => { assert.ok(p.length <= 128); const rows = all(sql, p); maxRows = Math.max(maxRows, rows.length); assert.ok(rows.length <= 1000); return rows; };
    raw.run = (sql, p = []) => { maxBindings = Math.max(maxBindings, p.length); assert.ok(p.length <= 128); if (fault && sql.includes(fault)) throw new Error('injected archive failure'); return run(sql, p); };
    raw.exec = sql => {
      if (fault === 'COMMIT_RESPONSE_LOST' && sql === 'COMMIT') { fault = null; exec(sql); throw new Error('commit response lost'); }
      if (fault && sql === fault) throw new Error('injected archive failure'); return exec(sql);
    };
    if (!isSnapshot) { const open = raw.openSnapshot; raw.openSnapshot = () => { snapshotCount++; return wrap(open(), true); }; }
    raw.close = () => { if (isSnapshot) snapshotCount--; close(); }; return raw;
  }
  async function open() { driver = wrap(openNodeSqlite(path)); db = createRelationalSqlite({ driver, storeId, mode: 'standalone', authorize: async () => user, ledgerEpoch: db ? undefined : ledgerEpoch }); await db.init(); }
  await open(); t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); });
  return { get db() { return db; }, get driver() { return driver; }, fault: value => fault = value, user: value => user = { ...user, ...value },
    get stats() { return { snapshotCount, maxRows, maxBindings }; }, async reopen() { await db.close(); await open(); } };
}
const task = async (f, type, data, memberId) => f.db.executeTask({ id: randomUUID(), storeId, ledgerEpoch: (await f.db.getBook()).ledgerEpoch, type, data, ...(memberId ? { memberId } : {}) });
async function money(f, memberId, options = {}) {
  return f.db.executeCommand({ id: randomUUID(), ledgerEpoch: (await f.db.getBook()).ledgerEpoch, type: 'recharge', memberId, expectedAccountVersion: (await f.db.getMember(memberId)).accountVersion, actualPayCents: '101', giftCents: '0', ...options });
}
async function seed(f, count = 2) {
  await f.db.importOpeningBalances({ ledgerEpoch: (await f.db.getBook()).ledgerEpoch, batchId: randomUUID(), sourceDigest: 'a'.repeat(64), expectedCount: count,
    members: Array.from({ length: count }, (_, i) => ({ id: 'member-' + i, name: '合成🦊' + i, balanceCents: i ? '0' : '-9', tags: ['甲'] })) });
  await money(f, 'member-0');
  await task(f, 'member.update', { name: '修改合成', expectedVersion: '0' }, 'member-0');
  const b = { id: randomUUID(), storeId, ledgerEpoch, actorId, deviceId, sourceDigest: 'b'.repeat(64), items: [{ id: randomUUID(), type: 'member.create', data: { name: '未执行行', tags: ['乙', '甲'] } }] };
  await f.db.captureBatch(b); return b;
}
async function exported(f) { const lines = []; const result = await f.db.exportArchive({ write: async line => lines.push(line) }); return { content: lines.join(''), result }; }
const capture = async (f, digest) => ({ id: randomUUID(), ledgerEpoch: (await f.db.getBook()).ledgerEpoch, actorId, deviceId, digest });

test('SQLite streaming preview rolls back; restore preserves full history/batches and original receipt survives lost response, restart and new money', async t => {
  const source = await fixture(t); await seed(source); const file = await exported(source), target = await fixture(t), c = await capture(target, file.result.digest);
  const preview = await target.db.previewArchiveRestore({ ...c, chunks: chunks(file.content, 37) });
  assert.equal(preview.memberCount, 2); assert.equal(preview.entryCount, 1); assert.equal(preview.digest, c.digest);
  assert.equal((await target.db.listMembers()).items.length, 0); assert.equal(target.driver.all('SELECT count(*) AS n FROM local_audit')[0].n, '0');
  const restored = await target.db.restoreArchive({ ...c, chunks: chunks(file.content, 31) });
  assert.notEqual(restored.ledgerEpoch, ledgerEpoch); assert.equal((await target.db.getMember('member-0')).balanceCents, '92');
  assert.equal(target.driver.all('SELECT count(*) AS n FROM application_batch_items')[0].n, '1');
  await money(target, 'member-0'); await target.reopen();
  assert.deepEqual(await target.db.getRestoreReceipt(c), restored);
  let pulled = false;
  assert.deepEqual(await target.db.restoreArchive({ ...c, chunks: (async function* () { pulled = true; throw new Error('must not read a completed file'); })() }), restored);
  assert.equal(pulled, false); assert.equal((await target.db.getMember('member-0')).balanceCents, '193');
  for (const change of [{ digest: 'f'.repeat(64) }, { ledgerEpoch: randomUUID() }]) await assert.rejects(target.db.getRestoreReceipt({ ...c, ...change }), { code: 'RESTORE_TASK_CONFLICT' });
  target.user({ id: 'other-owner' }); await assert.rejects(target.db.getRestoreReceipt(c), { code: 'AUTH_CONTEXT_CHANGED' }); target.user({ id: actorId });
  assert.throws(() => target.driver.run('UPDATE local_restore_receipts SET entry_count=0'), /immutable/);
  assert.throws(() => target.driver.run('DELETE FROM local_restore_receipts'), /immutable/);
  const next = await exported(target), third = await fixture(t); await third.db.restoreArchive({ ...await capture(third, next.result.digest), chunks: chunks(next.content) });
  assert.equal((await third.db.getMember('member-0')).balanceCents, '193');
  const bounded = await target.db.exportBackup(), fourth = await fixture(t); await fourth.db.restoreBackup(bounded, await capture(fourth, bounded.digest)); assert.equal((await fourth.db.getMember('member-0')).balanceCents, '193');
});

test('bounded restore also requires a stable fully captured task and cannot be rebound by caller mutation while hashing', async t => {
  const source = await fixture(t); await seed(source); const backup = await source.db.exportBackup(), target = await fixture(t), c = await capture(target, backup.digest);
  await assert.rejects(target.db.restoreBackup(backup));
  for (const key of ['id', 'actorId', 'deviceId', 'ledgerEpoch', 'digest']) {
    const incomplete = { ...c }; delete incomplete[key]; await assert.rejects(target.db.restoreBackup(backup, incomplete));
  }
  const original = { ...c }, pending = target.db.restoreBackup(backup, c); Object.assign(c, { id: randomUUID(), ledgerEpoch: randomUUID(), digest: 'f'.repeat(64), actorId: 'other' });
  const result = await pending; assert.equal(result.taskId, original.id); assert.deepEqual(await target.db.getRestoreReceipt(original), result);
});

test('independent WAL export snapshot permits concurrent writes and always releases resources on sink failure, abort and close', async t => {
  const source = await fixture(t); await seed(source); const lines = []; let changed = false;
  const result = await source.db.exportArchive({ write: async line => {
    lines.push(line); if (!changed) { changed = true; await money(source, 'member-0'); await task(source, 'member.create', { name: '快照之后' }); }
  } });
  assert.equal(result.memberCount, 2); assert.equal(result.entryCount, 1); assert.equal((await source.db.listMembers()).items.length, 3);
  const target = await fixture(t); await target.db.restoreArchive({ ...await capture(target, result.digest), chunks: chunks(lines.join('')) });
  assert.equal((await target.db.getMember('member-0')).balanceCents, '92'); assert.equal((await target.db.listMembers()).items.length, 2);
  await assert.rejects(source.db.exportArchive({ write: async () => { throw new Error('sink failed'); } }), /sink failed/); assert.equal(source.stats.snapshotCount, 0);
  const abort = new AbortController();
  await assert.rejects(source.db.exportArchive({ signal: abort.signal, write: async () => abort.abort() }), { code: 'ARCHIVE_ABORTED' }); assert.equal(source.stats.snapshotCount, 0);
  await assert.rejects(source.db.exportArchive({ write: async () => source.db.close() }), /不可用|已关闭/); assert.equal(source.stats.snapshotCount, 0);
});

test('SQLite streaming restore corruption, failed audit/receipt/COMMIT and cancelled preview roll back every row and epoch', async t => {
  const source = await fixture(t); await seed(source); const file = await exported(source), target = await fixture(t), c = await capture(target, file.result.digest);
  for (const failure of ['INSERT INTO local_restore_receipts', 'INSERT INTO local_audit', 'COMMIT']) {
    target.fault(failure); await assert.rejects(target.db.restoreArchive({ ...c, chunks: chunks(file.content) }), /injected/); target.fault(null);
    assert.equal((await target.db.getBook()).ledgerEpoch, ledgerEpoch); assert.equal((await target.db.listMembers()).items.length, 0);
  }
  for (const content of [file.content.slice(0, -1), file.content.replace('合成', '篡改')]) await assert.rejects(target.db.restoreArchive({ ...c, chunks: chunks(content) }));
  await assert.rejects(target.db.restoreArchive({ ...c, digest: 'f'.repeat(64), chunks: chunks(file.content) }), { code: 'BACKUP_REVIEW_REQUIRED' });
  const abort = new AbortController();
  await assert.rejects(target.db.previewArchiveRestore({ ...c, signal: abort.signal, chunks: (async function* () { for await (const chunk of chunks(file.content, 333)) { yield chunk; abort.abort(); } })() }), { code: 'ARCHIVE_ABORTED' });
  assert.equal((await target.db.listMembers()).items.length, 0); assert.equal(target.driver.all('SELECT count(*) AS n FROM local_restore_receipts')[0].n, '0');
  await target.db.restoreArchive({ ...c, chunks: chunks(file.content) });
  assert.equal((await target.db.getMember('member-0')).balanceCents, '92');
});

test('actual successful COMMIT with lost driver response is never repeated after reopening the poisoned connection', async t => {
  const source = await fixture(t); await seed(source); const file = await exported(source), target = await fixture(t), c = await capture(target, file.result.digest);
  target.fault('COMMIT_RESPONSE_LOST'); await assert.rejects(target.db.restoreArchive({ ...c, chunks: chunks(file.content) }), /commit response lost/);
  await assert.rejects(target.db.getBook(), /不可用/); await target.reopen();
  const result = await target.db.getRestoreReceipt(c); assert.equal(result.entryCount, 1);
  await money(target, 'member-0');
  assert.deepEqual(await target.db.restoreArchive({ ...c }), result);
  assert.equal((await target.db.getMember('member-0')).balanceCents, '193');
});

test('preview rollback failure reports failure and poisons the connection; reopening exposes no imported rows', async t => {
  const source = await fixture(t); await seed(source); const file = await exported(source), target = await fixture(t), c = await capture(target, file.result.digest);
  target.fault('ROLLBACK'); await assert.rejects(target.db.previewArchiveRestore({ ...c, chunks: chunks(file.content) }), /injected/);
  await assert.rejects(target.db.getBook(), /不可用/); target.fault(null); await target.reopen(); assert.equal((await target.db.listMembers()).items.length, 0);
});

test('recomputed archive chains cannot bypass funds, receipt, snapshots, task, batch, audit or opening validation', async t => {
  const source = await fixture(t); await seed(source); const file = await exported(source), target = await fixture(t), c = await capture(target, file.result.digest);
  const { BACKUP_TABLES } = await import('../src/relational-backup-rows.js');
  for (const [table, column, value] of [['member_accounts', 'balance_cents', '93'], ['command_receipts', 'balance_after_cents', '93'], ['payment_records', 'amount_cents', '100'],
    ['task_member_results', 'balance_cents', '93'], ['application_batch_items', 'name', '篡改'], ['local_audit', 'actor_id', 'wrong'], ['account_openings', 'batch_id', null]]) {
    const content = await rechain(file.content, records => {
      const rows = records.find(r => r.kind === 'rows' && r.table === table).rows;
      const row = table === 'local_audit' ? rows.find(row => row[BACKUP_TABLES.local_audit.indexOf('event')] === 'ledger_recharge') : rows[0];
      row[BACKUP_TABLES[table].indexOf(column)] = value;
    });
    // Preview has no reviewed digest shortcut: it must check database semantics.
    await assert.rejects(target.db.previewArchiveRestore({ ...c, chunks: chunks(content) }), table + ' must fail');
    assert.equal((await target.db.listMembers()).items.length, 0);
  }
});

test('streaming identity/epoch fences apply before and during restore and export, and missing snapshot support fails explicitly', async t => {
  const source = await fixture(t); await seed(source); const file = await exported(source), target = await fixture(t), c = await capture(target, file.result.digest);
  await assert.rejects(target.db.restoreArchive({ ...c, actorId: 'other', chunks: chunks(file.content) }), { code: 'AUTH_CONTEXT_CHANGED' });
  await assert.rejects(target.db.restoreArchive({ ...c, ledgerEpoch: randomUUID(), chunks: chunks(file.content) }), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(target.db.restoreArchive({ ...c, chunks: (async function* () { yield new TextEncoder().encode(file.content.split('\n')[0] + '\n'); target.user({ id: 'other' }); for await (const bytes of chunks(file.content.slice(file.content.indexOf('\n') + 1))) yield bytes; })() }), { code: 'AUTH_CONTEXT_CHANGED' });
  target.user({ id: actorId }); assert.equal((await target.db.listMembers()).items.length, 0);
  let switched = false;
  await assert.rejects(source.db.exportArchive({ write: async () => { if (!switched) { switched = true; source.user({ id: 'other' }); } } }), { code: 'AUTH_CONTEXT_CHANGED' });
  assert.equal(source.stats.snapshotCount, 0); source.user({ id: actorId });
  source.driver.openSnapshot = undefined; await assert.rejects(source.db.exportArchive({ write() {} }), { code: 'ARCHIVE_SNAPSHOT_UNAVAILABLE' });
});

test('one member history crosses multiple bounded validation pages and rowid zero is preserved', async t => {
  const source = await fixture(t); await seed(source, 1);
  source.driver.run('INSERT INTO local_audit(id,store_id,actor_id,device_id,event,entity_id,occurred_at) VALUES(0,?,?,?,?,?,?)', [storeId, actorId, deviceId, 'test_marker', 'row-zero', '2026-11-19T00:00:00.000Z']);
  for (let i = 0; i < 132; i++) await money(source, 'member-0');
  const file = await exported(source), target = await fixture(t), c = await capture(target, file.result.digest);
  await target.db.restoreArchive({ ...c, chunks: chunks(file.content) }); assert.equal((await target.db.getMember('member-0')).balanceCents, String(-9 + 133 * 101));
  assert.equal(target.driver.all('SELECT entity_id FROM local_audit WHERE id=0')[0].entity_id, 'row-zero');
  assert.ok(source.stats.maxRows <= 200); assert.ok(target.stats.maxRows <= 200); assert.ok(target.stats.maxBindings <= 120);
});
