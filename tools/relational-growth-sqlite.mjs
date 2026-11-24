import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openNodeSqlite } from './sqlite-node-driver.mjs';
import { createRelationalSqlite } from '../src/relational-sqlite.js';
import { LICENSE_FEATURES } from '../src/license-policy.js';
import { refactorSources } from './refactor-source.mjs';

// Synthetic desktop capacity experiment only. It creates unique artifacts
// under output/ and accepts no database URL, existing path or member data.
// Direct fixture seeding is NOT evidence for 100,000 app-command transactions.
const smoke = process.argv.includes('--smoke');
if (process.argv.slice(2).some(arg => arg !== '--smoke')) throw new Error('Only --smoke is supported');
const memberCount = smoke ? 10 : 1000, entryCount = smoke ? 100 : 100000, versions = entryCount / memberCount;
const runId = new Date().toISOString().replace(/[-:.]/g, '') + '-sqlite-growth' + (smoke ? '-smoke' : '-d1');
const directory = join(process.cwd(), 'output/refactor-v2', runId); await mkdir(directory, { recursive: true });
const sources = await refactorSources(process.cwd());
await writeFile(join(directory, 'source-manifest.json'), JSON.stringify(sources.manifest, null, 2) + '\n');
const storeId = 'synthetic-growth-store', actorId = 'synthetic-growth-owner', deviceId = 'synthetic-growth-device', ledgerEpoch = '00000000-0000-4000-8000-000000000001', at = '2026-11-19T00:00:00.000Z';
const opening = index => BigInt(index % 7 - 3) * 100n;
// Independent closed-form reference, not a call to production financial code.
const reference = (index, count = versions) => opening(index) + BigInt(Math.ceil(count / 2)) * 101n - BigInt(Math.floor(count / 2)) * 37n;
let queries = 0, peakQueryRows = 0, peakBindings = 0, activeSnapshots = 0, peakHeapUsed = 0, peakRss = 0;
const memory = [];
function sample(label) { const m = process.memoryUsage(); peakHeapUsed = Math.max(peakHeapUsed, m.heapUsed); peakRss = Math.max(peakRss, m.rss); if (label) memory.push({ label, rss: m.rss, heapUsed: m.heapUsed, external: m.external }); return m; }
function instrument(driver, snapshot = false) {
  const all = driver.all, run = driver.run, close = driver.close;
  driver.all = (sql, parameters = []) => {
    const rows = all(sql, parameters); peakQueryRows = Math.max(peakQueryRows, rows.length); peakBindings = Math.max(peakBindings, parameters.length);
    assert.ok(rows.length <= 1000 && parameters.length <= 128); if (++queries % 128 === 0) sample(); return rows;
  };
  driver.run = (sql, parameters = []) => { peakBindings = Math.max(peakBindings, parameters.length); assert.ok(parameters.length <= 128); return run(sql, parameters); };
  if (!snapshot) { const open = driver.openSnapshot; driver.openSnapshot = () => { activeSnapshots++; return instrument(open(), true); }; }
  driver.close = () => { if (snapshot) activeSnapshots--; return close(); }; return driver;
}
const authorize = async () => ({ storeId, id: actorId, deviceId, role: 'owner', features: LICENSE_FEATURES });
const openRepo = async name => { const repo = createRelationalSqlite({ driver: instrument(openNodeSqlite(join(directory, name + '.sqlite'))), storeId, mode: 'standalone', ledgerEpoch, authorize }); await repo.init(); return repo; };
const timings = {}, measure = async (name, work) => { sample(name + ':start'); const start = performance.now(); const result = await work(); timings[name] = Number((performance.now() - start).toFixed(2)); globalThis.gc?.(); sample(name + ':end'); return result; };
let source, target, report;
try {
  source = await openRepo('source'); await source.close(); source = null;
  await measure('seed', async () => {
    const db = new DatabaseSync(join(directory, 'source.sqlite')); db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    try {
      const insert = table => { const columns = db.prepare('PRAGMA table_info(' + table + ')').all().length; return db.prepare('INSERT INTO ' + table + ' VALUES(' + Array(columns).fill('?').join(',') + ')'); };
      const statements = Object.fromEntries(['member_profiles', 'member_accounts', 'account_opening_batches', 'account_openings', 'ledger_entries', 'command_receipts', 'local_command_configurations', 'consumption_items', 'payment_records', 'recharge_details', 'store_recharge_settings'].map(table => [table, insert(table)]));
      const audit = db.prepare('INSERT INTO local_audit(store_id,actor_id,device_id,event,entity_id,occurred_at) VALUES(?,?,?,?,?,?)');
      let net = 0n, positive = 0n, negative = 0n;
      for (let i = 0; i < memberCount; i++) { const n = opening(i); net += n; if (n > 0n) positive += n; if (n < 0n) negative += n; }
      const batchId = 'synthetic-growth-opening';
      statements.account_opening_batches.run(storeId, batchId, 'a'.repeat(64), 'b'.repeat(64), memberCount, net, positive, negative, at);
      statements.store_recharge_settings.run(storeId, 0, 1, 1000);
      audit.run(storeId, actorId, deviceId, 'account_opening_imported', batchId, at);
      for (let i = 0; i < memberCount; i++) {
        const memberId = 'synthetic-' + String(i).padStart(5, '0');
        statements.member_profiles.run(storeId, memberId, '合成增长会员' + i, '', '', 0, at, at, null);
        statements.member_accounts.run(storeId, memberId, reference(i), versions);
        statements.account_openings.run(storeId, memberId, batchId, memberId, opening(i));
        let balance = opening(i);
        for (let v = 1; v <= versions; v++) {
          const commandId = 'synthetic-command-' + String(i * versions + v).padStart(12, '0'), recharge = v % 2 === 1, kind = recharge ? 'recharge' : 'consume', delta = recharge ? 101n : -37n, after = balance + delta;
          statements.ledger_entries.run(storeId, commandId, memberId, kind, v, delta, balance, after, recharge ? 101 : 0, 0, recharge ? '现金' : '', '合成容量', '', actorId, deviceId, at);
          statements.command_receipts.run(storeId, commandId, 'c'.repeat(64), actorId, deviceId, memberId, kind, delta, balance, after, v, at, ledgerEpoch);
          statements.local_command_configurations.run(storeId, commandId, 0);
          if (recharge) {
            statements.payment_records.run(storeId, commandId, 0, '现金', 101);
            statements.recharge_details.run(storeId, commandId, 0, null, 101, 0, 1, 1000);
          } else statements.consumption_items.run(storeId, commandId, 0, null, '合成服务', 1, 37, 37);
          audit.run(storeId, actorId, deviceId, 'ledger_' + kind, commandId, at); balance = after;
        }
        assert.equal(balance, reference(i));
      }
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; } finally { db.close(); }
  });
  source = await openRepo('source'); target = await openRepo('target'); globalThis.gc?.(); const baseline = sample('before-streaming');
  const path = join(directory, 'synthetic-book.ndjson'), output = createWriteStream(path, { flags: 'wx' }), complete = finished(output); complete.catch(() => {});
  const bytesHash = createHash('sha256'); let count = 0, concurrentWriteMs;
  let exported;
  try {
    exported = await measure('export', () => source.exportArchive({ write: async line => {
      bytesHash.update(line); await new Promise((resolve, reject) => output.write(line, 'utf8', error => error ? reject(error) : resolve()));
      if (++count === 1) {
        const start = performance.now();
        await source.executeCommand({ id: 'synthetic-after-snapshot', ledgerEpoch, type: 'recharge', memberId: 'synthetic-00000', expectedAccountVersion: String(versions), actualPayCents: '101' });
        concurrentWriteMs = Number((performance.now() - start).toFixed(2));
      }
      if (count % 128 === 0) sample('export:frame-' + count);
    } }));
    output.end(); await complete;
  } catch (error) { output.destroy(); await complete.catch(() => {}); throw error; }
  const expectedBytesHash = bytesHash.digest('hex'), readback = createHash('sha256');
  await measure('externalReadback', async () => { for await (const chunk of createReadStream(path)) readback.update(chunk); });
  assert.equal(readback.digest('hex'), expectedBytesHash); assert.equal((await stat(path)).size, exported.byteLength); assert.equal(exported.entryCount, entryCount); assert.equal(activeSnapshots, 0);
  const capture = { id: 'synthetic-growth-restore-task', actorId, deviceId, ledgerEpoch, digest: exported.digest };
  const preview = await measure('preview', () => target.previewArchiveRestore({ ...capture, chunks: createReadStream(path) }));
  assert.equal(preview.memberCount, memberCount); assert.equal(preview.entryCount, entryCount); assert.equal((await target.listMembers()).items.length, 0);
  const restored = await measure('restore', () => target.restoreArchive({ ...capture, chunks: createReadStream(path) }));
  await measure('referenceCheck', async () => {
    let after, seen = 0;
    do { const page = await target.listMembers({ limit: 100, after }); for (const row of page.items) { const index = Number(row.id.slice('synthetic-'.length)); assert.equal(row.balanceCents, String(reference(index))); assert.equal(row.accountVersion, String(versions)); seen++; } after = page.nextCursor; } while (after);
    assert.equal(seen, memberCount);
    const response = await target.executeCommand({ id: 'synthetic-post-restore-command', ledgerEpoch: restored.ledgerEpoch, type: 'consume', memberId: 'synthetic-00000', expectedAccountVersion: String(versions), amountCents: '1' });
    assert.equal(response.balanceAfterCents, String(reference(0) - 1n));
    assert.deepEqual(await target.restoreArchive(capture), restored);
    assert.equal((await target.getMember('synthetic-00000')).balanceCents, String(reference(0) - 1n));
  });
  const heapGrowth = peakHeapUsed - baseline.heapUsed;
  // A desktop regression ceiling, separate from the plan's phone/API gates.
  assert.ok(heapGrowth < 96 * 1024 * 1024, 'Sampled JS heap grew beyond desktop streaming regression ceiling');
  assert.ok(peakBindings <= 128 && peakQueryRows <= 1000);
  const probe = new DatabaseSync(':memory:'), sqliteVersion = probe.prepare('SELECT sqlite_version() AS v').get().v; probe.close();
  report = { runId, status: 'passed', scope: 'synthetic seeded desktop SQLite capacity experiment; not command-throughput, PG, Android, D2/D3 or release acceptance', fixture: { memberCount, entryCount, seed: 'closed-form-alternating-101-minus37-v1', seededInSingleTransaction: true },
    environment: { node: process.version, sqlite: sqliteVersion, platform: process.platform, forcedGcBetweenPhases: typeof globalThis.gc === 'function' },
    timingsMs: { ...timings, concurrentWriteDuringExport: concurrentWriteMs }, archive: { ...exported, sha256: expectedBytesHash },
    bounds: { queries, peakQueryRows, peakBindings, activeSnapshots, peakHeapUsed, peakRss, sampledHeapGrowth: heapGrowth, desktopHeapGrowthCeiling: 96 * 1024 * 1024 }, memory,
    assertions: ['external byte readback digest', 'snapshot excludes concurrent committed money', 'preview leaves target empty', 'all member balances and versions equal independent formula', 'restore keeps counts and digest', 'new business after restore', 'original restore retry preserves later business', 'bounded SQL results and bindings', 'sampled JS heap ceiling'], releaseDecision: 'blocked' };
} catch (error) { report = { runId, status: 'failed', message: error.message, stack: error.stack, timingsMs: timings, bounds: { queries, peakQueryRows, peakBindings, activeSnapshots, peakHeapUsed, peakRss }, memory, releaseDecision: 'blocked' }; process.exitCode = 1; }
finally { await source?.close(); await target?.close(); }
report.sourceDigest = sources.digest; report.sourceFileCount = sources.count;
report.sourceUnchangedDuringExperiment = (await refactorSources(process.cwd())).digest === sources.digest;
if (!report.sourceUnchangedDuringExperiment) { report.status = 'failed'; report.message = 'Source changed during experiment'; process.exitCode = 1; }
await writeFile(join(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, memory: report.memory?.filter(row => !row.label.startsWith('export:frame-')), artifacts: directory }, null, 2));
