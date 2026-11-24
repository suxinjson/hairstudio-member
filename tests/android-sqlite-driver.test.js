import test from 'node:test';
import assert from 'node:assert/strict';
import { openAndroidSqlite } from '../src/android-sqlite-driver.js';

test('Android driver preserves signed 64-bit text across the bridge and rejects floating point binds', async () => {
  const calls = [], plugin = { async open() {}, async close() { calls.push('closed'); }, async run(input) { calls.push(input); }, async all() { return { rows: [{ value: '9223372036854775807' }] }; } };
  await assert.rejects(openAndroidSqlite({ plugin, native: false }), /原生/);
  const driver = await openAndroidSqlite({ plugin, native: true });
  await driver.run('INSERT', [9223372036854775807n, '-9223372036854775808', null, 1]);
  assert.deepEqual(calls[0].parameters, ['9223372036854775807', '-9223372036854775808', null, '1']);
  await assert.rejects(driver.run('INSERT', [Number.MAX_SAFE_INTEGER + 1])); await assert.rejects(driver.run('INSERT', [0.1]));
  assert.equal((await driver.all('SELECT'))[0].value, '9223372036854775807'); await driver.close();
  await assert.rejects(driver.all('SELECT'), /关闭/);
});

test('Android snapshots own an independent opaque reader and release it with their parent', async () => {
  const token = '12345678-1234-4123-8123-123456789abc', calls = [], plugin = {
    async open() {}, async close() { calls.push(['close']); },
    async openSnapshot() { calls.push(['openSnapshot']); return { token }; },
    async snapshotExec(input) { calls.push(['begin', input]); },
    async snapshotAll(input) { calls.push(['read', input]); return { rows: [{ min: '-9223372036854775808', nil: null }] }; },
    async closeSnapshot(input) { calls.push(['closeSnapshot', input]); }
  };
  const driver = await openAndroidSqlite({ native: true, plugin }), snapshot = await driver.openSnapshot();
  await assert.rejects(driver.openSnapshot(), /快照/); await assert.rejects(snapshot.exec('COMMIT'), /只读/);
  await snapshot.exec('BEGIN'); assert.equal((await snapshot.all('SELECT', [9223372036854775807n]))[0].min, '-9223372036854775808');
  assert.deepEqual(calls.at(-1), ['read', { token, sql: 'SELECT', parameters: ['9223372036854775807'] }]);
  await driver.close(); await snapshot.close(); assert.deepEqual(calls.slice(-2), [['closeSnapshot', { token }], ['close']]);
  await assert.rejects(snapshot.all('SELECT'), /关闭/);
});

test('Android driver rejects overlapping opens and closes readers that finish opening after parent shutdown', async () => {
  let release; const calls = [], plugin = { async open() {}, async close() { calls.push('parent'); }, openSnapshot: () => new Promise(resolve => { release = resolve; }), async closeSnapshot() { calls.push('reader'); } };
  const driver = await openAndroidSqlite({ native: true, plugin }), pending = driver.openSnapshot();
  await assert.rejects(driver.openSnapshot()); await driver.close(); release({ token: '12345678-1234-4123-8123-123456789abc' });
  await assert.rejects(pending, /关闭/); assert.deepEqual(calls, ['parent', 'reader']);
});

test('Android driver rejects oversized or numeric query responses and invalid snapshot captures', async () => {
  let response; const plugin = { async open() {}, async close() {}, async all() { return response; }, async openSnapshot() { return { token: 'invalid' }; } };
  const driver = await openAndroidSqlite({ native: true, plugin });
  for (response of [{ rows: Array(1001).fill({}) }, { rows: [{ cents: 9007199254740992 }] }, { rows: [null] }, { rows: {} }]) await assert.rejects(driver.all('SELECT'), /响应/);
  await assert.rejects(driver.openSnapshot(), /响应/); await driver.close();
});
