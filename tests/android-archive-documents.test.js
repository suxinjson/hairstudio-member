import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { sha256Stream } from '../src/sha256-stream.js';
import { androidArchiveDocuments } from '../src/android-archive-documents.js';
import { archiveDocumentPlugin } from './helpers/archive-document-plugin.mjs';

test('incremental SHA-256 matches the independent crypto oracle across padding, blocks and arbitrary chunk boundaries', () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 65535, 65536, 1048583]) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + (i >>> 3)) & 255), expected = createHash('sha256').update(bytes).digest('hex');
    for (const width of [1, 63, 257, 65536]) {
      const hash = sha256Stream(); for (let at = 0; at < length; at += width) hash.update(bytes.subarray(at, at + width));
      assert.equal(hash.byteLength, length); assert.equal(hash.hex(), expected); assert.equal(hash.hex(), expected); assert.throws(() => hash.update(new Uint8Array()));
    }
  }
  assert.throws(() => sha256Stream().update('abc'));
});

test('Android archive writes bounded UTF-8 chunks and requires independent external readback before success', async () => {
  const fake = archiveDocumentPlugin(), docs = androidArchiveDocuments({ native: true, plugin: fake.plugin });
  const handle = await docs.create({ fileName: 'book.ndjson' }), text = '会员😀'.repeat(30000) + '\n';
  await handle.write(text); assert.ok(fake.calls.filter(c => c[0] === 'writeChunk').every(c => c[1] <= 65536));
  assert.equal(fake.calls.some(c => c[0] === 'verifyChunk'), false);
  const result = await handle.finish(); assert.equal(result.status, 'saved-verified'); assert.equal(fake.bytes.toString('utf8'), text);
  assert.equal(result.sha256, createHash('sha256').update(text).digest('hex'));
  await handle.close(); assert.equal(fake.calls.some(c => c[0] === 'close'), false);
  const next = await docs.open(); await next.close();
  assert.deepEqual(fake.calls[0], ['create', { fileName: 'book.ndjson' }]);
});

test('Android archive rereads a selected external document in complete bounded passes without caching the file', async () => {
  const fake = archiveDocumentPlugin(Buffer.from('中😀'.repeat(30000))), handle = await androidArchiveDocuments({ native: true, plugin: fake.plugin }).open();
  for (let pass = 0; pass < 2; pass++) {
    const hash = createHash('sha256'); let length = 0;
    for await (const bytes of handle.chunks()) { assert.ok(bytes.length <= 65536); hash.update(bytes); length += bytes.length; }
    assert.deepEqual(handle.lastRead, { sha256: hash.digest('hex'), byteLength: length });
    const info = handle.lastRead; info.byteLength = -1; assert.equal(handle.lastRead.byteLength, length);
    fake.bytes = Buffer.from('changed document');
  }
  assert.equal(fake.calls.filter(c => c[0] === 'beginRead').length, 2); await handle.close();
});

test('Android archive rejects reordered blocks, noncanonical base64, incorrect lengths and forged EOF checksums', async () => {
  for (const corrupt of [r => ({ ...r, sequence: 7 }), r => ({ ...r, data: 'Y Q==' }), r => ({ ...r, byteLength: 999 }), r => r.done ? ({ ...r, sha256: '0'.repeat(64) }) : r]) {
    const fake = archiveDocumentPlugin(Buffer.from('a')), read = fake.plugin.readChunk; fake.plugin.readChunk = async input => corrupt(await read(input));
    const handle = await androidArchiveDocuments({ native: true, plugin: fake.plugin }).open();
    await assert.rejects(async () => { for await (const _ of handle.chunks()) {} });
    assert.equal(fake.calls.at(-1)[0], 'cancel');
  }
});

test('Android archive rejects a mismatched write acknowledgement and unverified/mutated readback', async () => {
  for (const method of ['writeChunk', 'beginVerify', 'verifyChunk']) {
    const fake = archiveDocumentPlugin(), original = fake.plugin[method];
    fake.plugin[method] = async input => ({ ...await original(input), byteLength: -1 });
    const handle = await androidArchiveDocuments({ native: true, plugin: fake.plugin }).create({ fileName: 'book.ndjson' });
    await assert.rejects(async () => { await handle.write('abc'); await handle.finish(); }); assert.equal(fake.calls.at(-1)[0], 'cancel');
  }
});

test('Android archive cancels stalled I/O, ignores late replies and releases its JS handle', async () => {
  const fake = archiveDocumentPlugin(); let release;
  fake.plugin.beginWrite = () => new Promise(resolve => { release = resolve; });
  const docs = androidArchiveDocuments({ native: true, plugin: fake.plugin, idleMs: 20 }), handle = await docs.create({ fileName: 'book.ndjson' });
  await assert.rejects(handle.write('abc'), { code: 'ARCHIVE_ABORTED' }); release({ sequence: 0, byteLength: 0 });
  assert.equal(fake.calls.at(-1)[0], 'cancel'); await assert.rejects(handle.finish());
  const next = await docs.open(); await next.close();
});

test('Android archive blocks overlapping operations and cancels a partially consumed read iterator', async () => {
  const fake = archiveDocumentPlugin(Buffer.alloc(150000)), docs = androidArchiveDocuments({ native: true, plugin: fake.plugin }), handle = await docs.open();
  await assert.rejects(docs.open(), { code: 'BACKUP_FILE_BUSY' });
  const iterator = handle.chunks(); await iterator.next();
  await assert.rejects(handle.chunks().next(), { code: 'BACKUP_FILE_BUSY' });
  await iterator.return(); assert.equal(handle.lastRead, null); assert.equal(fake.calls.at(-1)[0], 'cancel');
  const next = await docs.open(); await next.close();
});

test('Android archive aborts picker and active I/O without waiting for a provider, and handles cancellation and invalid capture', async () => {
  let resolve, cancelled = 0; const controller = new AbortController(), plugin = { choose: () => new Promise(r => { resolve = r; }), async cancel() { cancelled++; } };
  const docs = androidArchiveDocuments({ native: true, plugin }), pending = docs.open({ signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { code: 'ARCHIVE_ABORTED' }); resolve({ cancelled: true }); assert.equal(cancelled, 1);
  plugin.choose = async () => ({ cancelled: true }); assert.equal((await docs.open()).status, 'cancelled');
  plugin.choose = async () => ({ token: randomUUID().slice(0, 10) }); await assert.rejects(docs.open());
  await assert.rejects(docs.create({ fileName: '../bad.ndjson' })); await assert.rejects(androidArchiveDocuments({ native: false }).open(), { code: 'BACKUP_FILE_UNAVAILABLE' });
  const fake = archiveDocumentPlugin(), abort = new AbortController(), handle = await androidArchiveDocuments({ native: true, plugin: fake.plugin }).open({ signal: abort.signal });
  fake.plugin.beginRead = () => new Promise(() => {}); const read = handle.chunks().next(); abort.abort(); await assert.rejects(read, { code: 'ARCHIVE_ABORTED' });
});

test('Android archive rejects invalid Unicode and enforces total selected-handle lifetime independently of idle I/O', async () => {
  const fake = archiveDocumentPlugin(), docs = androidArchiveDocuments({ native: true, plugin: fake.plugin });
  const writer = await docs.create({ fileName: 'book.ndjson' }); await assert.rejects(writer.write(String.fromCharCode(0xd800)), /Unicode/);
  assert.equal(fake.calls.some(c => c[0] === 'writeChunk'), false);
  const limited = androidArchiveDocuments({ native: true, plugin: fake.plugin, totalMs: 1 }), reader = await limited.open();
  await new Promise(resolve => setTimeout(resolve, 5)); await assert.rejects(reader.chunks().next(), { code: 'ARCHIVE_ABORTED' });
});
