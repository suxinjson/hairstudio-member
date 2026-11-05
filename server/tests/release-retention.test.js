import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../database.js';
import { publishRelease } from '../publish-release.js';
import { buildUpdateManifest } from '../../tools/update-manifest.js';

let database, pool, failCommit = false, failCleanup = false;
before(async () => {
  database = new PGlite();
  pool = {
    query: (sql, args) => args ? database.query(sql, args) : sql.includes(';') ? database.exec(sql) : database.query(sql),
    async connect() { return { query: async (sql, args) => {
      if (sql === 'COMMIT' && failCommit) { failCommit = false; throw new Error('failed COMMIT'); }
      if (sql === 'SELECT file_name FROM releases' && failCleanup) throw new Error('cleanup unavailable');
      return pool.query(sql, args);
    }, release() {} }; }
  };
  await migrate(pool);
});
beforeEach(async () => { failCommit = false; failCleanup = false; await pool.query('TRUNCATE releases'); });
after(async () => { await database.close(); });
const certificate = 'a'.repeat(64);
const release = version => {
  const bytes = Buffer.from('APK version ' + version);
  return { bytes, manifest: buildUpdateManifest(bytes, { versionCode: version, versionName: '1.0.' + version, certificateSha256: certificate }) };
};
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'member-retention-test-'));
  t.after(async () => { assert.ok(resolve(path).startsWith(resolve(tmpdir()) + sep + 'member-retention-test-')); await rm(path, { recursive: true }); });
  return path;
}

test('failed publication COMMIT preserves all files still referenced by the rolled-back database', async t => {
  const path = await directory(t), first = release(1), next = release(2);
  await publishRelease(pool, first.manifest, first.bytes, path, certificate, { retentionCount: 1 });
  failCommit = true;
  await assert.rejects(publishRelease(pool, next.manifest, next.bytes, path, certificate, { retentionCount: 1 }), /failed COMMIT/);
  const rows = (await pool.query('SELECT version_code FROM releases')).rows;
  assert.deepEqual(rows.map(row => row.version_code), [1]);
  assert.deepEqual(await readFile(join(path, first.manifest.sha256 + '.apk')), first.bytes);
  await publishRelease(pool, next.manifest, next.bytes, path, certificate, { retentionCount: 1 });
  assert.deepEqual(await readdir(path), [next.manifest.sha256 + '.apk']);
});

test('cleanup failure leaves a committed release downloadable and an idempotent retry finishes cleanup', async t => {
  t.mock.method(console, 'warn', () => {});
  const path = await directory(t), first = release(1), next = release(2);
  await publishRelease(pool, first.manifest, first.bytes, path, certificate, { retentionCount: 1 });
  failCleanup = true;
  const result = await publishRelease(pool, next.manifest, next.bytes, path, certificate, { retentionCount: 1 });
  assert.equal(result.cleanupPending, true);
  assert.deepEqual((await pool.query('SELECT version_code FROM releases')).rows.map(row => row.version_code), [2]);
  assert.deepEqual(await readFile(join(path, next.manifest.sha256 + '.apk')), next.bytes);
  assert.equal((await readdir(path)).length, 2);
  failCleanup = false;
  const retry = await publishRelease(pool, next.manifest, next.bytes, path, certificate, { retentionCount: 1 });
  assert.equal(retry.unchanged, true); assert.equal(retry.cleanupPending, undefined);
  assert.deepEqual(await readdir(path), [next.manifest.sha256 + '.apk']);
});

test('retention refuses invalid counts before modifying files or the release table', async t => {
  const path = await directory(t), first = release(1);
  for (const count of [-1, NaN, Infinity, 0.5]) await assert.rejects(publishRelease(pool, first.manifest, first.bytes, path, certificate, { retentionCount: count }));
  assert.deepEqual(await readdir(path), []);
  assert.deepEqual((await pool.query('SELECT * FROM releases')).rows, []);
});
