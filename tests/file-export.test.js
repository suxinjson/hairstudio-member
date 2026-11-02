import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileExporter, isExportCancelled } from '../src/file-export.js';

const file = { content: '{"members":[]}', fileName: '账本.json', mimeType: 'application/json', title: '账本' };

test('native export waits for the file write and URI before sharing', async () => {
  const calls = [];
  let completeWrite;
  const writeDone = new Promise(resolve => { completeWrite = resolve; });
  const exporter = createFileExporter({
    isNative: () => true,
    filesystem: {
      async writeFile(options) { calls.push(['write', options]); await writeDone; },
      async getUri(options) { calls.push(['uri', options]); return { uri: 'file:///cache/exports/账本.json' }; }
    },
    share: { async share(options) { calls.push(['share', options]); } },
    browser: () => { throw new Error('Native export must not use browser downloads'); }
  });
  const exported = exporter(file);
  await Promise.resolve();
  assert.deepEqual(calls.map(call => call[0]), ['write']);
  completeWrite();
  assert.equal((await exported).kind, 'shared');
  assert.deepEqual(calls.map(call => call[0]), ['write', 'uri', 'share']);
  assert.equal(calls[0][1].data, file.content);
  assert.equal(calls[0][1].encoding, 'utf8');
  assert.equal(calls[0][1].directory, 'CACHE');
  assert.deepEqual(calls[2][1].files, ['file:///cache/exports/账本.json']);
});

test('native write failures never invoke sharing or report success', async () => {
  let shared = false;
  const exporter = createFileExporter({
    isNative: () => true,
    filesystem: { async writeFile() { throw new Error('disk full'); } },
    share: { async share() { shared = true; } }
  });
  await assert.rejects(exporter(file), /disk full/);
  assert.equal(shared, false);
});

test('a missing native URI prevents sharing', async () => {
  let shared = false;
  const exporter = createFileExporter({
    isNative: () => true,
    filesystem: { async writeFile() {}, async getUri() { return {}; } },
    share: { async share() { shared = true; } }
  });
  await assert.rejects(exporter(file));
  assert.equal(shared, false);
});

test('browser fallback requests download and retains the Blob until the deferred cleanup', async () => {
  const calls = [];
  let cleanup;
  const exporter = createFileExporter({
    isNative: () => false,
    browser: () => ({
      navigator: {},
      document: {
        createElement() { return { click() { calls.push('click'); }, remove() { calls.push('remove'); } }; },
        body: { appendChild() { calls.push('append'); } }
      },
      URL: { createObjectURL() { return 'blob:backup'; }, revokeObjectURL() { calls.push('revoke'); } }
    }),
    defer(callback) { cleanup = callback; }
  });
  assert.equal((await exporter(file)).kind, 'download-requested');
  assert.deepEqual(calls, ['append', 'click', 'remove']);
  cleanup();
  assert.equal(calls.at(-1), 'revoke');
});

test('share cancellation is propagated and recognized for both native and browser errors', async () => {
  const cancellation = new Error('Share canceled');
  const exporter = createFileExporter({
    isNative: () => true,
    filesystem: { async writeFile() {}, async getUri() { return { uri: 'file:///cache/backup.json' }; } },
    share: { async share() { throw cancellation; } }
  });
  await assert.rejects(exporter(file), error => error === cancellation && isExportCancelled(error));
  assert.equal(isExportCancelled({ name: 'AbortError' }), true);
  assert.equal(isExportCancelled(new Error('disk full')), false);
});
