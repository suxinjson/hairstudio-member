import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { androidBackupDocuments } from '../src/android-backup-documents.js';
import { createRelationalBackupFiles } from '../src/relational-backup-files.js';
import { createRelationalSqlite, sha256 } from '../src/relational-sqlite.js';
import { canonicalJSON } from '../src/canonical-json.js';
import { DATA_LIMITS, byteLength } from '../src/data-limits.js';
import { LICENSE_FEATURES } from '../src/license-policy.js';
import { openNodeSqlite } from '../tools/sqlite-node-driver.mjs';

const storeId = 'external-book-store', deviceId = 'external-device-2026', actorId = 'external-owner';
const baseScope = { storeId, actorId, deviceId };
async function file(content) { return { fileName: 'external-backup.json', content, byteLength: byteLength(content), sha256: await sha256(content) }; }
async function fixture(t, mode = 'standalone') {
  const directory = await mkdtemp(join(tmpdir(), 'member-backup-file-')), driver = openNodeSqlite(join(directory, 'book.sqlite')); let actor = actorId, fault = false;
  const exec = driver.exec; driver.exec = sql => { if (fault && sql === 'COMMIT') throw new Error('injected commit fault'); exec(sql); };
  const repository = createRelationalSqlite({ driver, storeId, mode, ledgerEpoch: randomUUID(), authorize: async () => ({ storeId, id: actor, deviceId, role: 'owner', features: LICENSE_FEATURES }) });
  await repository.init(); t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { repository, driver, actor: value => { actor = value; }, fault: value => { fault = value; } };
}
async function sample(t) {
  const original = await fixture(t), book = await original.repository.getBook();
  const member = await original.repository.createMember({ name: '外部备份合成会员' }, { ...book, id: randomUUID() });
  await original.repository.executeCommand({ ...book, id: randomUUID(), memberId: member.id, type: 'recharge', expectedAccountVersion: '0', actualPayCents: '1010' });
  await original.repository.executeCommand({ ...book, id: randomUUID(), memberId: member.id, type: 'consume', expectedAccountVersion: '1', amountCents: '10' });
  const backup = await original.repository.exportBackup(); return { ...original, backup, member, document: await file(canonicalJSON(backup)) };
}
test('Android document adapter stages bytes separately, saves only token/name in the picker call, and releases its capture', async () => {
  const calls = [], token = randomUUID(), content = '{"备份":true}';
  const plugin = { async stage(input) { calls.push(['stage', input]); return { token }; }, async save(input) { calls.push(['save', input]); return { status: 'saved-verified', fileName: 'book.json', byteLength: byteLength(content), sha256: await sha256(content) }; }, async discard(input) { calls.push(['discard', input]); } };
  const docs = androidBackupDocuments({ native: true, plugin });
  assert.equal((await docs.save({ content, fileName: 'book.json' })).status, 'saved-verified');
  assert.deepEqual(calls.map(row => row[0]), ['stage', 'save', 'discard']); assert.deepEqual(calls[1][1], { token, fileName: 'book.json' });
  plugin.save = async () => ({ cancelled: true }); assert.deepEqual(await docs.save({ content, fileName: 'book.json' }), { status: 'cancelled' });
  plugin.save = async () => { throw new Error('provider write fault'); }; await assert.rejects(docs.save({ content, fileName: 'book.json' }), /provider write fault/);
  assert.equal(calls.at(-1)[0], 'discard');
});

test('Android adapter rejects private-path arguments, Unicode/size damage, invalid responses and overlapping pickers', async () => {
  const docs = androidBackupDocuments({ native: false }); await assert.rejects(docs.open(), { code: 'BACKUP_FILE_UNAVAILABLE' });
  let release, staged = 0; const waiting = new Promise(resolve => { release = resolve; }), plugin = { async open() { await waiting; return { cancelled: true }; }, async stage() { staged++; throw new Error('must not stage invalid input'); } };
  const native = androidBackupDocuments({ native: true, plugin }), pending = native.open();
  await assert.rejects(native.open(), { code: 'BACKUP_FILE_BUSY' }); release(); assert.deepEqual(await pending, { status: 'cancelled' });
  for (const input of [{ content: '{}', fileName: '../book.json' }, { content: String.fromCharCode(0xd800), fileName: 'book.json' }, { content: 'a'.repeat(DATA_LIMITS.restoreBytes + 1), fileName: 'book.json' }]) await assert.rejects(native.save(input));
  assert.equal(staged, 0);
  plugin.open = async () => ({ content: '{}', byteLength: 999, sha256: 'a'.repeat(64) }); await assert.rejects(native.open(), { code: 'BACKUP_FILE_READ_FAILED' });
});

test('standalone file workflow validates an actual complete backup, previews an empty target and restores captured funds once', async t => {
  const source = await sample(t), target = await fixture(t), flow = createRelationalBackupFiles({ repository: target.repository, getScope: () => baseScope, documents: { open: async () => source.document } });
  const preview = await flow.chooseRestore(); assert.equal(preview.status, 'preview'); assert.equal(preview.memberCount, 1); assert.equal(preview.entryCount, 2);
  assert.equal((await target.repository.listMembers()).items.length, 0); assert.equal('backup' in preview, false);
  preview.digest = 'b'.repeat(64); preview.ledgerEpoch = randomUUID(); // UI edits cannot change the private capture.
  await assert.rejects(flow.restore(preview.token, preview.digest), { code: 'BACKUP_REVIEW_REQUIRED' });
  const result = await flow.restore(preview.token, source.backup.digest); assert.equal(result.status, 'restored'); assert.equal(result.contextChanged, false);
  assert.equal((await target.repository.getMember(source.member.id)).balanceCents, '1000'); assert.equal(flow.getPreview(), null);
  await assert.rejects(flow.restore(preview.token, source.backup.digest), { code: 'BACKUP_REVIEW_REQUIRED' });
  const book = await target.repository.getBook(); await target.repository.executeCommand({ ...book, id: randomUUID(), type: 'consume', memberId: source.member.id, expectedAccountVersion: '2', amountCents: '1' });
  assert.equal((await target.repository.getMember(source.member.id)).balanceCents, '999');
});

test('file save reports success only for an exact external readback and distinguishes an account change after OS completion', async t => {
  const source = await sample(t); let scope = baseScope, corrupt = false, switchContext = false, capturedContent;
  const flow = createRelationalBackupFiles({ repository: source.repository, getScope: () => scope, documents: { async save({ content, fileName }) {
    capturedContent = content; if (switchContext) scope = null;
    return { status: 'saved-verified', fileName, byteLength: byteLength(content), sha256: corrupt ? 'b'.repeat(64) : await sha256(content) };
  } } });
  const saved = await flow.save(); assert.equal(saved.contextChanged, false); assert.equal(JSON.parse(capturedContent).digest, saved.digest);
  corrupt = true; await assert.rejects(flow.save(), { code: 'BACKUP_FILE_WRITE_FAILED' }); corrupt = false; switchContext = true;
  const completed = await flow.save(); assert.equal(completed.status, 'saved-verified'); assert.equal(completed.contextChanged, true);
});

test('cancelled and damaged files never retain an old preview or write target funds; cloud replicas refuse file replacement', async t => {
  const source = await sample(t), target = await fixture(t); let selected = source.document;
  const flow = createRelationalBackupFiles({ repository: target.repository, getScope: () => baseScope, documents: { open: async () => selected } });
  await flow.chooseRestore(); selected = { status: 'cancelled' }; assert.equal((await flow.chooseRestore()).status, 'cancelled'); assert.equal(flow.getPreview(), null);
  const inconsistent = JSON.parse(source.document.content); inconsistent.tables.member_accounts[0].balance_cents = '999';
  const { digest: _, ...payload } = inconsistent; inconsistent.digest = await sha256(canonicalJSON(payload));
  for (const content of ['{', source.document.content.replace('member-relational-sqlite', 'old-json-backup'), canonicalJSON(inconsistent)]) {
    selected = await file(content); await assert.rejects(flow.chooseRestore()); assert.equal(flow.getPreview(), null);
  }
  assert.equal((await target.repository.listMembers()).items.length, 0);
  const replica = await fixture(t, 'cloud'); await assert.rejects(replica.repository.previewBackupRestore(source.backup), { code: 'WRONG_AUTHORITY' });
});

test('preview identity and target epoch are bound both in the file flow and inside the SQLite restore transaction', async t => {
  const source = await sample(t), target = await fixture(t); let scope = baseScope;
  const flow = createRelationalBackupFiles({ repository: target.repository, getScope: () => scope, documents: { open: async () => source.document } });
  const preview = await flow.chooseRestore(); scope = { ...baseScope, actorId: 'different-owner' };
  await assert.rejects(flow.restore(preview.token, preview.digest), { code: 'AUTH_CONTEXT_CHANGED' }); scope = baseScope;
  target.actor('different-owner'); await assert.rejects(flow.restore(preview.token, preview.digest), { code: 'AUTH_CONTEXT_CHANGED' }); target.actor(actorId);
  assert.equal((await target.repository.listMembers()).items.length, 0);
  const current = await target.repository.getBook(); await target.repository.restoreBackup(source.backup, { ...current, id: randomUUID(), actorId, deviceId, digest: source.backup.digest });
  await assert.rejects(flow.restore(preview.token, preview.digest), { code: 'LEDGER_EPOCH_MISMATCH' });
  assert.notEqual((await target.repository.getBook()).ledgerEpoch, current.ledgerEpoch);
});

test('failed restore commit preserves the reviewed file capture and original empty target for explicit retry', async t => {
  const source = await sample(t), target = await fixture(t), book = await target.repository.getBook();
  const flow = createRelationalBackupFiles({ repository: target.repository, getScope: () => baseScope, documents: { open: async () => source.document } });
  const preview = await flow.chooseRestore(); target.fault(true);
  await assert.rejects(flow.restore(preview.token, preview.digest), /injected/); target.fault(false);
  assert.deepEqual(await target.repository.getBook(), book); assert.equal(flow.getPreview().token, preview.token); assert.equal((await target.repository.listMembers()).items.length, 0);
  assert.equal((await flow.restore(preview.token, preview.digest)).status, 'restored'); assert.equal((await target.repository.getMember(source.member.id)).balanceCents, '1000');
});

test('file restore reuses its captured task after a committed response is lost and later transactions exist', async t => {
  const source = await sample(t), target = await fixture(t), restore = target.repository.restoreBackup; let lost = true;
  target.repository.restoreBackup = async (...args) => { const result = await restore(...args); if (lost) { lost = false; throw new Error('response lost'); } return result; };
  const flow = createRelationalBackupFiles({ repository: target.repository, getScope: () => baseScope, documents: { open: async () => source.document } }), preview = await flow.chooseRestore();
  await assert.rejects(flow.restore(preview.token, preview.digest), /response lost/); assert.equal(flow.getPreview().token, preview.token);
  const book = await target.repository.getBook(); await target.repository.executeCommand({ ...book, id: randomUUID(), memberId: source.member.id, type: 'consume', expectedAccountVersion: '2', amountCents: '1' });
  const result = await flow.restore(preview.token, preview.digest); assert.equal(result.result.taskId, preview.token); assert.equal(flow.getPreview(), null);
  assert.equal((await target.repository.getMember(source.member.id)).balanceCents, '999');
  assert.equal(target.driver.all('SELECT count(*) AS n FROM local_restore_receipts')[0].n, '1');
});

test('native document source uses bounded SAF streams and readback; it never puts the full book in saved picker options', async () => {
  const native = await readFile(new URL('../android/app/src/main/java/com/hairstudio/memberapp/BackupDocumentsPlugin.java', import.meta.url), 'utf8');
  assert.match(native, /ACTION_CREATE_DOCUMENT/); assert.match(native, /ACTION_OPEN_DOCUMENT/);
  assert.match(native, /total > maxBytes/); assert.match(native, /limit <= MAX_BYTES/);
  assert.match(native, /CodingErrorAction.REPORT/); assert.match(native, /MessageDigest.isEqual/); assert.match(native, /"content"\.equals\(uri.getScheme\(\)\)/);
  assert.equal(/getCacheDir|getFilesDir|FileOutputStream|WRITE_EXTERNAL_STORAGE|takePersistableUriPermission/.test(native), false);
  const activity = await readFile(new URL('../android/app/src/main/java/com/hairstudio/memberapp/MainActivity.java', import.meta.url), 'utf8'); assert.match(activity, /registerPlugin\(BackupDocumentsPlugin.class\)/);
});
