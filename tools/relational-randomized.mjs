import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, rmdir, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRelationalSqlite } from '../src/relational-sqlite.js';
import { LICENSE_FEATURES } from '../src/license-policy.js';
import { createService } from '../server/tests/helpers/licensed-service.js';
import { relationalTestDatabase } from '../server/tests/helpers/relational-database.js';
import { exerciseLedger } from '../tests/helpers/ledger-random-model.mjs';
import { openNodeSqlite } from './sqlite-node-driver.mjs';
import { refactorSources } from './refactor-source.mjs';

const { values } = parseArgs({ options: { engine: { type: 'string' }, start: { type: 'string', default: '1' }, seeds: { type: 'string', default: '1000' },
  steps: { type: 'string', default: '200' }, workers: { type: 'string', default: '1' } } });
const { engine } = values;
function integer(name, max) {
  assert.match(values[name], /^[1-9][0-9]*$/, name);
  const n = Number(values[name]); assert.ok(n <= max, name); return n;
}
const start = integer('start', 990001), seeds = integer('seeds', 1000), steps = integer('steps', 200), workers = integer('workers', 4);
assert.ok(['sqlite', 'postgres'].includes(engine), 'Use --engine sqlite|postgres');
assert.ok(workers <= seeds, 'Workers must not exceed the number of seeds');
if (engine === 'postgres') {
  const url = new URL(process.env.MEMBER_RELATIONAL_TEST_DATABASE_URL || 'about:blank');
  if (url.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !/^member_[a-z_]*test(_[a-z0-9_]+)?$/.test(url.pathname.slice(1)) || process.env.MEMBER_TEST_DATABASE_DISPOSABLE !== '1') {
    throw new Error('Requires a disposable loopback member_*test database');
  }
}

async function postgresWorker() {
  const db = await relationalTestDatabase();
  try {
    await db.pool.query("CREATE FUNCTION random_fixture_time() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN NEW.occurred_at := current_setting(''member.random_fixture_time'')::timestamptz; RETURN NEW; END'; CREATE TRIGGER random_fixture_clock BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION random_fixture_time()");
    let fault = false, time, identity, refreshed;
    const pool = {
      query: (...args) => db.pool.query(...args),
      async connect() {
        const client = await db.pool.connect();
        return {
          async query(sql, params) {
            if (sql.startsWith('INSERT INTO ledger_entries(')) await client.query("SELECT set_config('member.random_fixture_time',$1,true)", [time]);
            const result = await client.query(sql, params);
            if (fault && sql.startsWith('INSERT INTO audit_events(') && /^ledger_/.test(params[3])) { fault = false; throw new Error('randomized audit failure'); }
            return result;
          }, release: (...args) => client.release(...args)
        };
      }
    };
    const service = createService(pool), password = randomUUID() + '!A7', username = 'random-owner', deviceId = randomUUID();
    const { storeId } = await service.createOwner({ username, password });
    let session = await service.login({ username, password, deviceId }, '127.0.0.1');
    identity = await service.authenticate(session.accessToken); refreshed = Date.now();
    const scope = await service.relational.getBook(identity); assert.equal(scope.storeId, storeId);
    const query = async (sql, args) => { let i = 0; return (await db.pool.query(sql.replaceAll('?', () => '$' + ++i), args)).rows; };
    return { version: db.version, close: db.close,
      async scenario() {
        // This schema was created for this worker. Keep login/entitlements;
        // each seed starts with a fresh empty business book.
        await db.pool.query('TRUNCATE member_profiles,account_opening_batches,ledger_command_receipts,application_task_receipts,store_changes,store_change_heads,store_recharge_settings,audit_events RESTART IDENTITY CASCADE');
        fault = false;
        return checkFixture({ scope, postgres: true, query, actor: identity.id, deviceId, close() {}, setTime: value => { time = value; }, failNextAudit: () => { fault = true; },
          async call(name, ...args) {
            if (Date.now() - refreshed > 8 * 60000) { session = await service.refresh(session.refreshToken, 'web'); identity = await service.authenticate(session.accessToken); refreshed = Date.now(); }
            return service.relational[name](identity, ...args);
          } });
      } };
  } catch (error) { await db.close(); throw error; }
}

async function sqliteWorker() {
  const directory = await mkdtemp(join(tmpdir(), 'member-ledger-random-'));
  const storeId = 'sqlite-random-fixture', ledgerEpoch = '00000000-0000-4000-8000-000000000001', actor = 'random-owner', deviceId = 'random-test-device';
  const engineProbe = openNodeSqlite(':memory:'), version = engineProbe.all('SELECT sqlite_version() AS version')[0].version; engineProbe.close();
  return { version, close: () => rmdir(directory),
    async scenario(seed) {
      const path = join(directory, String(seed) + '.sqlite'), driver = openNodeSqlite(path), run = driver.run;
      let time = '2025-01-01T00:00:00.000Z', fault = false;
      driver.run = (sql, params) => {
        const result = run(sql, params);
        if (fault && sql.startsWith('INSERT INTO local_audit(') && /^ledger_/.test(params[3])) { fault = false; throw new Error('randomized audit failure'); }
        return result;
      };
      const db = createRelationalSqlite({ driver, storeId, ledgerEpoch, mode: 'standalone', now: () => time,
        authorize: async () => ({ storeId, id: actor, deviceId, role: 'owner', features: LICENSE_FEATURES }) });
      try { await db.init(); } catch (error) { driver.close(); await rm(path, { force: true }); throw error; }
      return checkFixture({ scope: { storeId, ledgerEpoch }, postgres: false, query: driver.all, actor, deviceId,
        close: async () => { await db.close(); await rm(path, { force: true }); },
        setTime: value => { time = value; }, failNextAudit: () => { fault = true; }, call: (name, ...args) => db[name](...args) });
    } };
}

function checkFixture(fixture) {
  const { scope, postgres, query, call, actor, deviceId } = fixture;
  const { storeId, ledgerEpoch } = scope;
  const commandReceipts = postgres ? 'ledger_command_receipts' : 'command_receipts';
  const taskReceipts = postgres ? 'application_task_receipts' : 'local_task_receipts';
  const audit = postgres ? 'audit_events' : 'local_audit';
  const auditId = postgres ? "details->>'commandId'" : 'entity_id', taskAuditId = postgres ? "details->>'taskId'" : 'entity_id';
  const auditActor = postgres ? 'user_id' : 'actor_id';
  const moneyEvents = "event IN ('ledger_recharge','ledger_consume','ledger_reversal')";
  const bindAuthor = ' AND ' + auditActor + '=? AND device_id=?';
  const normalizeAccount = row => [row.member_id, String(row.balance_cents), String(row.account_version), String(row.profile_version), row.name, Boolean(row.archived_at)];
  const modeledAccount = m => [m.id, String(m.balanceCents), m.accountVersion, m.profileVersion, m.name, m.archived];
  const normalizeEntry = row => [row.id, row.memberId, row.kind ?? row.type, row.accountVersion, row.deltaCents, row.balanceBeforeCents, row.balanceAfterCents,
    row.actualPayCents, row.giftCents, row.originalEntryId, row.occurredAt];
  const order = (a, b) => a.occurredAt === b.occurredAt ? (a.id < b.id ? 1 : -1) : a.occurredAt < b.occurredAt ? 1 : -1;
  return { ...fixture,
    async checkOpenings(rows) {
      const saved = await query('SELECT member_id,opening_balance_cents FROM account_openings WHERE store_id=? ORDER BY member_id', [storeId]);
      assert.deepEqual(saved.map(r => [r.member_id, String(r.opening_balance_cents)]), rows.map(r => [r.id, r.balanceCents]));
    },
    async inspect(member, id, entry, taskType) {
      const [saved] = await query('SELECT a.member_id,a.balance_cents,a.version AS account_version,p.profile_version,p.name,p.archived_at,' +
        ' e.entry_id,e.member_id AS entry_member_id,e.kind,e.delta_cents,e.balance_before_cents,e.balance_after_cents,e.account_version AS entry_version,e.actual_pay_cents,e.gift_cents,e.occurred_at,l.original_entry_id,' +
        ' (SELECT count(*) FROM ' + commandReceipts + ' r WHERE r.store_id=a.store_id AND r.command_id=? AND r.ledger_epoch=? AND r.actor_id=? AND r.device_id=?) AS receipts,' +
        ' (SELECT count(*) FROM ' + audit + ' au WHERE au.store_id=a.store_id AND ' + auditId + '=? AND ' + moneyEvents + bindAuthor + ') AS audits,' +
        ' (SELECT task_type FROM ' + taskReceipts + ' t WHERE t.store_id=a.store_id AND t.task_id=?) AS task_type' +
        ' FROM member_accounts a JOIN member_profiles p ON p.store_id=a.store_id AND p.id=a.member_id' +
        ' LEFT JOIN ledger_entries e ON e.store_id=a.store_id AND e.entry_id=?' +
        ' LEFT JOIN ledger_reversals l ON l.store_id=a.store_id AND l.reversal_entry_id=e.entry_id' +
        ' WHERE a.store_id=? AND a.member_id=?', [id, ledgerEpoch, actor, deviceId, id, actor, deviceId, id, id, storeId, member.id]);
      assert.deepEqual(normalizeAccount(saved), modeledAccount(member));
      assert.deepEqual([Number(saved.receipts), Number(saved.audits), saved.task_type], [Number(Boolean(entry)), Number(Boolean(entry)), taskType ?? null]);
      assert.deepEqual(saved.entry_id === null ? null : [saved.entry_id, saved.entry_member_id, saved.kind, String(saved.entry_version), String(saved.delta_cents),
        String(saved.balance_before_cents), String(saved.balance_after_cents), String(saved.actual_pay_cents), String(saved.gift_cents), saved.original_entry_id,
        new Date(saved.occurred_at).toISOString()], entry === null ? null : normalizeEntry(entry));
    },
    async checkFinal({ people, rows, entries, links, taskIds, config }) {
      await this.checkOpenings(rows);
      const accounts = await query('SELECT a.member_id,a.balance_cents,a.version AS account_version,p.profile_version,p.name,p.archived_at FROM member_accounts a JOIN member_profiles p ON p.store_id=a.store_id AND p.id=a.member_id WHERE a.store_id=? ORDER BY a.member_id', [storeId]);
      assert.deepEqual(accounts.map(normalizeAccount), people.map(modeledAccount));
      assert.deepEqual((await query('SELECT command_id FROM ' + commandReceipts + ' WHERE store_id=? ORDER BY command_id', [storeId])).map(row => row.command_id), [...entries.keys()]);
      assert.deepEqual((await query('SELECT ' + auditId + ' AS command_id,event FROM ' + audit + ' WHERE store_id=? AND ' + moneyEvents + ' ORDER BY command_id', [storeId])).map(r => [r.command_id, r.event]),
        [...entries.values()].map(({ row }) => [row.id, 'ledger_' + row.kind]));
      assert.deepEqual((await query('SELECT task_id FROM ' + taskReceipts + ' WHERE store_id=? ORDER BY task_id', [storeId])).map(r => r.task_id), taskIds);
      assert.deepEqual((await query('SELECT ' + taskAuditId + " AS task_id FROM " + audit + " WHERE store_id=? AND event='task_completed' ORDER BY task_id", [storeId])).map(r => r.task_id), taskIds);
      const savedLinks = await query('SELECT original_entry_id,reversal_entry_id FROM ledger_reversals WHERE store_id=?', [storeId]);
      assert.deepEqual(new Map(savedLinks.map(r => [r.original_entry_id, r.reversal_entry_id])), links);
      const configuration = await call('getConfiguration', scope);
      assert.deepEqual([configuration.version, configuration.rechargeSettings], [String(config.version), { giftEnabled: config.giftEnabled, giftRateBasisPoints: config.giftRateBasisPoints }]);
      const expected = [...entries.values()].map(({ row }) => row).sort(order);
      let cursor, visited = 0;
      do {
        const page = await call('listLedger', { ...scope, cursor, limit: 17 });
        const slice = expected.slice(visited, visited + 17);
        assert.deepEqual(page.items.map(normalizeEntry), slice.map(normalizeEntry));
        assert.deepEqual(page.items.map(row => row.reversalEntryId), slice.map(row => links.get(row.id) ?? null));
        visited += slice.length; cursor = page.nextCursor;
        assert.equal(Boolean(cursor), visited < expected.length);
      } while (cursor);
      if (!postgres) assert.equal((await call('syncState')).pendingCount, 0);
      else {
        const head = rows.length + entries.size * 2 + links.size + taskIds.length, published = new Set();
        let after = 0, page;
        do {
          page = await call('changes', { ...scope, after: String(after), limit: 73 });
          assert.equal(page.head, String(head));
          for (const item of page.items) {
            assert.equal(item.cursor, String(++after));
            assert.ok(item.value, 'Committed change must have a projection');
            if (item.entityType === 'ledger') published.add(item.entityId);
          }
          assert.equal(page.cursor, String(after));
        } while (page.hasMore && after < head);
        assert.equal(after, head); assert.deepEqual(published, new Set(entries.keys()));
      }
    }
  };
}

const root = fileURLToPath(new URL('../', import.meta.url)), startedAt = new Date().toISOString();
const runId = startedAt.replace(/[-:.]/g, '') + '-random-' + engine, directory = join(root, 'output/refactor-v2', runId);
await mkdir(directory, { recursive: true });
const source = await refactorSources(root), versions = new Set(), completed = [], outcomes = {};
const save = (name, value) => writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n');
await save('source-manifest.json', source.manifest);
let nextSeed = start, failure;
const record = kind => { outcomes[kind] = (outcomes[kind] ?? 0) + 1; };
console.log(JSON.stringify({ runId, engine, start, seeds, steps, workers, sourceDigest: source.digest }));
async function run() {
  const worker = await (engine === 'sqlite' ? sqliteWorker : postgresWorker)(); versions.add(worker.version);
  try {
    while (!failure && nextSeed < start + seeds) {
      const seed = nextSeed++, scenario = await worker.scenario(seed);
      try { await exerciseLedger(scenario, seed, steps, record); completed.push(seed); }
      catch (error) { failure ??= error; throw error; }
      finally { await scenario.close(); }
      if (completed.length === seeds || completed.length % 10 === 0) await appendFile(join(directory, 'progress.ndjson'), JSON.stringify({ at: new Date().toISOString(), seedsCompleted: completed.length, seed, outcomes }) + '\n');
    }
  } finally { await worker.close(); }
}
const results = await Promise.allSettled(Array.from({ length: workers }, () => run().catch(error => { failure ??= error; throw error; })));
const sourceUnchanged = (await refactorSources(root)).digest === source.digest;
const passed = !failure && results.every(result => result.status === 'fulfilled') && sourceUnchanged && completed.length === seeds;
const summary = { runId, startedAt, finishedAt: new Date().toISOString(), engine, databaseVersions: [...versions], node: process.version, os: process.platform,
  sourceDigest: source.digest, sourceFileCount: source.count, sourceUnchanged, start, seeds, steps, workers, seedsCompleted: completed.length,
  stepsCompleted: completed.length * steps, outcomes, status: passed ? 'pass' : 'failed',
  scope: 'Generated data; real database transactions on workstation. Not target performance, release or Android acceptance.' };
if (failure) await save('failure.json', { scenario: failure.scenario, code: failure.code, message: failure.message, stack: failure.stack });
await save('summary.json', summary); console.log(JSON.stringify({ ...summary, error: failure?.message })); process.exitCode = passed ? 0 : 1;
