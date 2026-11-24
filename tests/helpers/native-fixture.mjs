import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import assert from 'node:assert/strict';
import { openNodeSqlite } from '../../tools/sqlite-node-driver.mjs';

export function memoryStorage() {
  const values = new Map();
  return { values, get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key) };
}

export function nativeCredentials(deviceId) {
  let access = null, session = null, binding = null;
  return {
    async getDeviceId() { return { deviceId, deviceFingerprint: 'a'.repeat(64), deviceName: 'isolated-test' }; },
    async loadAccess() { return { access }; }, async saveAccess(value) { access = value.access; },
    async loadSession() { return { session }; }, async saveSession(value) { session = value.session; },
    async clearSession() { session = null; },
    async loadBookBinding() { return { binding }; }, async saveBookBinding(value) { binding = value.binding; }
  };
}

export async function nativeFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'member-device-book-'));
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'book.sqlite');
  let fault, opened = 0;
  return {
    get opened() { return opened; },
    failCommit(stage) { fault = stage; },
    open() {
      opened++;
      const driver = openNodeSqlite(path);
      return { ...driver, exec(sql) {
        if (sql !== 'COMMIT' || !fault) return driver.exec(sql);
        const stage = fault; fault = null;
        if (stage === 'after') driver.exec(sql);
        throw new Error('commit response unavailable');
      } };
    }
  };
}
