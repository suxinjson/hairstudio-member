import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRelationalArchiveFiles } from '../src/relational-archive-files.js';
import { androidArchiveDocuments } from '../src/android-archive-documents.js';
import { createRelationalSqlite } from '../src/relational-sqlite.js';
import { LICENSE_FEATURES } from '../src/license-policy.js';
import { openNodeSqlite } from '../tools/sqlite-node-driver.mjs';
import { archiveDocumentPlugin } from './helpers/archive-document-plugin.mjs';

const scope = { storeId: 'stream-file-store', actorId: 'stream-file-owner', deviceId: 'stream-file-device' };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'member-stream-file-')), driver = openNodeSqlite(join(directory, 'book.sqlite'));
  let fault = false; const exec = driver.exec;
  driver.exec = sql => { if (fault && sql === 'COMMIT') throw new Error('injected commit fault'); exec(sql); };
  const repository = createRelationalSqlite({ driver, storeId: scope.storeId, mode: 'standalone', ledgerEpoch: randomUUID(), authorize: async () => ({ ...scope, id: scope.actorId, role: 'owner', features: LICENSE_FEATURES }) });
  await repository.init(); t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { repository, driver, fault: value => { fault = value; } };
}
async function sample(t) {
  const source = await fixture(t), book = await source.repository.getBook(), member = await source.repository.createMember({ name: '流式合成会员😀' }, { ...book, id: randomUUID() });
  await source.repository.executeCommand({ ...book, id: randomUUID(), memberId: member.id, type: 'recharge', expectedAccountVersion: '0', actualPayCents: '1000' });
  const lines = []; await source.repository.exportArchive({ write: async line => { lines.push(line); } });
  return { ...source, bytes: Buffer.from(lines.join('')), member };
}
function flow(repository, fake, getScope = () => scope) {
  return createRelationalArchiveFiles({ repository, getScope, documents: androidArchiveDocuments({ native: true, plugin: fake.plugin }) });
}

test('stream file workflow previews and restores a real relational archive with only bounded review metadata retained', async t => {
  const source = await sample(t), target = await fixture(t), fake = archiveDocumentPlugin(source.bytes), files = flow(target.repository, fake);
  const preview = await files.chooseRestore(); assert.equal(preview.memberCount, 1); assert.equal(preview.entryCount, 1);
  assert.equal((await target.repository.listMembers()).items.length, 0); assert.equal('chunks' in preview || 'backup' in preview || 'content' in preview, false);
  preview.rowCounts.member_profiles = 999; preview.ledgerEpoch = randomUUID(); assert.equal(files.getPreview().rowCounts.member_profiles, 1);
  await assert.rejects(files.restore(preview.token, '0'.repeat(64)), { code: 'BACKUP_REVIEW_REQUIRED' });
  const result = await files.restore(preview.token, preview.digest); assert.equal(result.status, 'restored'); assert.equal(result.contextChanged, false);
  assert.equal((await target.repository.getMember(source.member.id)).balanceCents, '1000'); assert.equal(files.getPreview(), null);
  assert.equal(fake.calls.filter(c => c[0] === 'beginRead').length, 2); assert.equal(fake.calls.at(-1)[0], 'close');
});

test('stream save selects the external destination before acquiring a snapshot and reports verified exact bytes', async t => {
  const source = await sample(t), fake = archiveDocumentPlugin(), open = source.driver.openSnapshot; let selected = false;
  const create = fake.plugin.create; fake.plugin.create = async input => { const result = await create(input); selected = true; return result; };
  source.driver.openSnapshot = () => { assert.equal(selected, true); return open(); };
  const result = await flow(source.repository, fake).save(); assert.equal(result.status, 'saved-verified'); assert.equal(result.byteLength, fake.bytes.length);
  const target = await fixture(t); assert.equal((await flow(target.repository, archiveDocumentPlugin(fake.bytes)).chooseRestore()).digest, result.digest);
});

test('stream restore checks the original receipt before rereading an unavailable file and preserves later funds after a lost response', async t => {
  const source = await sample(t), target = await fixture(t), fake = archiveDocumentPlugin(source.bytes), files = flow(target.repository, fake), restore = target.repository.restoreArchive;
  target.repository.restoreArchive = async input => { await restore(input); throw new Error('response lost'); };
  const preview = await files.chooseRestore(); await assert.rejects(files.restore(preview.token, preview.digest), /response lost/);
  assert.equal(files.getPreview().token, preview.token);
  const book = await target.repository.getBook(); await target.repository.executeCommand({ ...book, id: randomUUID(), memberId: source.member.id, type: 'consume', amountCents: '1', expectedAccountVersion: '1' });
  fake.plugin.beginRead = async () => { throw new Error('file unavailable'); };
  const result = await files.restore(preview.token, preview.digest); assert.equal(result.result.taskId, preview.token);
  assert.equal((await target.repository.getMember(source.member.id)).balanceCents, '999');
  assert.equal(target.driver.all('SELECT count(*) AS n FROM local_restore_receipts')[0].n, '1');
});

test('stream restore rolls back a changed external file and preserves the original capture for explicit retry', async t => {
  const source = await sample(t), target = await fixture(t), fake = archiveDocumentPlugin(source.bytes), files = flow(target.repository, fake), preview = await files.chooseRestore();
  fake.bytes = Buffer.concat([source.bytes, Buffer.from('\n')]); await assert.rejects(files.restore(preview.token, preview.digest));
  assert.equal((await target.repository.listMembers()).items.length, 0); assert.equal(files.getPreview().token, preview.token);
  assert.equal(target.driver.all('SELECT count(*) AS n FROM local_restore_receipts')[0].n, '0'); await files.discardPreview(); assert.equal(files.getPreview(), null);
});

test('stream file byte checks run before database commit even when all relational rows parsed successfully', async t => {
  const source = await sample(t), target = await fixture(t), fake = archiveDocumentPlugin(source.bytes);
  const documents = androidArchiveDocuments({ native: true, plugin: fake.plugin }); let chosen;
  const files = createRelationalArchiveFiles({ repository: target.repository, getScope: () => scope, documents: { async open() {
    const handle = await documents.open(); let reads = 0;
    chosen = { fileName: handle.fileName, chunks: async function* () { yield* handle.chunks(); reads++; }, get lastRead() { return reads > 1 ? { ...handle.lastRead, sha256: '0'.repeat(64) } : handle.lastRead; }, close: () => handle.close(), cancel: () => handle.cancel() }; return chosen;
  } } });
  const preview = await files.chooseRestore(); await assert.rejects(files.restore(preview.token, preview.digest), { code: 'BACKUP_REVIEW_REQUIRED' });
  assert.equal((await target.repository.listMembers()).items.length, 0); assert.equal(target.driver.all('SELECT count(*) AS n FROM local_restore_receipts')[0].n, '0');
  await files.discardPreview();
});

test('stream restore retains its exact original task after failed COMMIT and does not rebind the target epoch', async t => {
  const source = await sample(t), target = await fixture(t), fake = archiveDocumentPlugin(source.bytes), files = flow(target.repository, fake), preview = await files.chooseRestore();
  target.fault(true); await assert.rejects(files.restore(preview.token, preview.digest), /injected/); target.fault(false);
  assert.equal((await target.repository.getBook()).ledgerEpoch, preview.ledgerEpoch); assert.equal((await target.repository.listMembers()).items.length, 0);
  assert.equal((await files.restore(preview.token, preview.digest)).status, 'restored');
});

test('stream preview binds the identity and epoch captured before the picker and closes replaced or cancelled captures', async t => {
  const source = await sample(t), target = await fixture(t), fake = archiveDocumentPlugin(source.bytes); let current = scope;
  const files = flow(target.repository, fake, () => current), preview = await files.chooseRestore();
  current = { ...scope, actorId: 'another-owner' }; await assert.rejects(files.restore(preview.token, preview.digest), { code: 'AUTH_CONTEXT_CHANGED' }); current = scope;
  fake.plugin.choose = async () => ({ cancelled: true }); assert.equal((await files.chooseRestore()).status, 'cancelled');
  assert.equal(files.getPreview(), null); assert.ok(fake.calls.some(c => c[0] === 'close'));
  const fake2 = archiveDocumentPlugin(source.bytes), create = fake2.plugin.choose;
  fake2.plugin.choose = async input => { const result = await create(input); current = null; return result; };
  await assert.rejects(flow(target.repository, fake2, () => current).chooseRestore(), { code: 'AUTH_CONTEXT_CHANGED' }); assert.equal(fake2.calls.at(-1)[0], 'cancel');
});

test('stream workflow abort rolls back inserts and releases the selected external document', async t => {
  const source = await sample(t), target = await fixture(t), fake = archiveDocumentPlugin(source.bytes), files = flow(target.repository, fake), controller = new AbortController(), read = fake.plugin.readChunk;
  fake.plugin.readChunk = async input => { const result = await read(input); controller.abort(); return result; };
  await assert.rejects(files.chooseRestore({ signal: controller.signal }), { code: 'ARCHIVE_ABORTED' });
  assert.equal((await target.repository.listMembers()).items.length, 0); assert.equal(files.getPreview(), null); assert.equal(fake.calls.at(-1)[0], 'cancel');
});

test('stream save retains completed-file truth if identity changes after readback and rejects forged success', async t => {
  const source = await sample(t); let current = scope;
  const fake = archiveDocumentPlugin(), verify = fake.plugin.verifyChunk;
  fake.plugin.verifyChunk = async input => { const result = await verify(input); current = null; return result; };
  assert.equal((await flow(source.repository, fake, () => current).save()).contextChanged, true);
  const damaged = archiveDocumentPlugin(), result = damaged.plugin.verifyChunk;
  damaged.plugin.verifyChunk = async input => ({ ...await result(input), sha256: '0'.repeat(64) });
  await assert.rejects(flow(source.repository, damaged).save(), { code: 'BACKUP_FILE_WRITE_FAILED' });
});

test('stalled external provider releases a live export snapshot and rolls back a restore that already inserted rows', async t => {
  const source = await sample(t), fake = archiveDocumentPlugin(); let released = 0;
  const open = source.driver.openSnapshot; source.driver.openSnapshot = () => { const reader = open(), close = reader.close; reader.close = () => { released++; close(); }; return reader; };
  fake.plugin.beginWrite = () => new Promise(() => {});
  const files = createRelationalArchiveFiles({ repository: source.repository, getScope: () => scope, documents: androidArchiveDocuments({ native: true, plugin: fake.plugin, idleMs: 30 }) });
  await assert.rejects(files.save(), { code: 'ARCHIVE_ABORTED' }); assert.equal(released, 1);
  assert.equal((await source.repository.getMember(source.member.id)).balanceCents, '1000');
  const target = await fixture(t), input = archiveDocumentPlugin(source.bytes), read = input.plugin.readChunk; let sawInsertedRows = false;
  input.plugin.readChunk = async args => {
    if (args.sequence > 0) { sawInsertedRows = target.driver.all('SELECT count(*) AS n FROM member_profiles')[0].n === '1'; return new Promise(() => {}); }
    return read(args);
  };
  const restore = createRelationalArchiveFiles({ repository: target.repository, getScope: () => scope, documents: androidArchiveDocuments({ native: true, plugin: input.plugin, idleMs: 30 }) });
  await assert.rejects(restore.chooseRestore(), { code: 'ARCHIVE_ABORTED' }); assert.equal(sawInsertedRows, true);
  assert.equal((await target.repository.listMembers()).items.length, 0); assert.equal(input.calls.at(-1)[0], 'cancel');
});

test('stream preview cannot silently bind a new target epoch while the system picker was open', async t => {
  const source = await sample(t), target = await fixture(t), fake = archiveDocumentPlugin(source.bytes), choose = fake.plugin.choose, original = await target.repository.getBook();
  fake.plugin.choose = async args => { const result = await choose(args); target.driver.run('UPDATE book_identity SET ledger_epoch=? WHERE singleton=1', [randomUUID()]); return result; };
  await assert.rejects(flow(target.repository, fake).chooseRestore(), { code: 'LEDGER_EPOCH_MISMATCH' });
  assert.notEqual((await target.repository.getBook()).ledgerEpoch, original.ledgerEpoch); assert.equal((await target.repository.listMembers()).items.length, 0);
});
