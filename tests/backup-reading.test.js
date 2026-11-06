import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope } from 'vue';
import { useBackupOperations } from '../src/composables/useBackupOperations.js';
import { DATA_LIMITS } from '../src/data-limits.js';

test('backup rejects oversize files before reading and ignores aborted or disposed reads', () => {
  const original = globalThis.FileReader, readers = [], errors = [];
  class FakeReader {
    readyState = 0; aborted = false;
    constructor() { readers.push(this); }
    readAsText(file) { this.file = file; this.readyState = 1; }
    abort() { this.aborted = true; this.readyState = 2; }
    complete(content) { this.onload({ target: { result: content } }); }
  }
  globalThis.FileReader = FakeReader;
  const scope = effectScope();
  try {
    const operations = scope.run(() => useBackupOperations({ localDb: { previewBackup: content => ({ content }) }, showFeedback: (...args) => errors.push(args) }));
    const select = (name, size) => operations.handleImportBackup({ target: { value: name, files: [{ name, size }] } });
    select('huge.json', DATA_LIMITS.backupBytes + 1);
    assert.equal(readers.length, 0); assert.equal(errors.length, 1);
    select('first.json', 10); select('second.json', 10);
    assert.equal(readers[0].aborted, true);
    readers[0].complete('obsolete');
    assert.equal(operations.backupRestoreRequest.value, null);
    readers[1].complete('current');
    assert.equal(operations.backupRestoreRequest.value.content, 'current');
    select('third.json', 10); scope.stop();
    assert.equal(readers[2].aborted, true);
    readers[2].complete('after-disposal');
    assert.equal(operations.backupRestoreRequest.value.content, 'current');
  } finally { scope.stop(); globalThis.FileReader = original; }
});
