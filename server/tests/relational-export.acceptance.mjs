import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as XLSX from 'xlsx';
import { createApi } from '../http.js';
import { createLedgerExportWorker } from '../relational-export-worker.js';
import { createService } from './helpers/licensed-service.js';
import { relationalTestDatabase } from './helpers/relational-database.js';
import { LEDGER_EXPORT, LEDGER_SHEET, XLSX_TYPE } from '../../src/relational-export-sheet.js';

const password = 'Export-Acceptance-Only-2026!';
const from = new Date(Date.now() - 86400000).toISOString(), to = new Date(Date.now() + 86400000).toISOString();
let db, pool, service, jobs, owner;
before(async () => {
  if (!process.env.MEMBER_RELATIONAL_TEST_DATABASE_URL) throw new Error('Real PostgreSQL is required');
  db = await relationalTestDatabase(); pool = db.pool; service = createService(pool); jobs = service.relational;
});
after(() => db?.close());
beforeEach(async () => { await pool.query('TRUNCATE stores,login_limits RESTART IDENTITY CASCADE'); owner = await loginStore('export-owner'); });
async function loginStore(username, options = {}) {
  if (!options.as) await service.createOwner({ username, password });
  const { accessToken } = await service.login({ username, password, deviceId: randomUUID() }, options.ip || '127.0.0.1');
  const identity = await service.authenticate(accessToken), book = await jobs.getBook(identity);
  return { identity, accessToken, ...book };
}
const request = (context, id = randomUUID()) => ({ id, ledgerEpoch: context.ledgerEpoch, from, to });
const capture = ({ storeId, ledgerEpoch }, id = randomUUID()) => ({ storeId, ledgerEpoch, id });
const current = (context = owner) => jobs.getLedgerExport(context.identity, context);
async function seed(context, count, { note = '+备注', outside = false } = {}) {
  const member = await jobs.createMember(context.identity, { name: '=A1' }, capture(context));
  await pool.query('INSERT INTO ledger_entries(store_id,entry_id,member_id,kind,account_version,delta_cents,balance_before_cents,balance_after_cents,actual_pay_cents,remark,actor_id,device_id,occurred_at) ' +
    "SELECT $1,'fixture-'||lpad(i::text,6,'0'),$2,'recharge',i,1,i-1,i,1,$3,$4,$5,CASE WHEN i>$6 THEN $7::timestamptz ELSE $8::timestamptz+interval '1 microsecond' END " +
    'FROM generate_series(1,$9::int) i',
  [context.storeId, member.id, note, context.identity.id, context.identity.device_id, count, to, from, count + Number(outside)]);
  await pool.query('UPDATE member_accounts SET balance_cents=$3, version=$3 WHERE store_id=$1 AND member_id=$2', [context.storeId, member.id, count + Number(outside)]);
  return member;
}

function gatePool(firstPage) {
  let seen = false;
  return { async connect() {
    const client = await pool.connect();
    return { on: client.on.bind(client), off: client.off.bind(client), release: client.release.bind(client), async query(sql, args) {
      const result = await client.query(sql, args);
      if (!seen && sql.startsWith('SELECT e.entry_id')) { seen = true; await firstPage(client); }
      return result;
    } };
  } };
}

async function listen(t) {
  const server = createApi({ service, pool, production: true, trustedProxyIPs: ['127.0.0.1'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return (context, suffix, body) => fetch('http://127.0.0.1:' + server.address().port + '/api/v2/exports/ledger' + suffix,
    { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: 'Bearer ' + context.accessToken, 'content-type': 'application/json', 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.11' } });
}

test('HTTP queues a 5,203-row XLSX, preserves one SQL snapshot under writes and isolates the artifact', { timeout: 30000 }, async t => {
  const member = await seed(owner, 5203, { outside: true });
  const http = await listen(t), req = request(owner), url = '?ledgerEpoch=' + owner.ledgerEpoch, file = '/' + req.id + '/file';
  const queued = await http(owner, '', req);
  assert.equal(queued.status, 202); assert.equal((await queued.json()).state, 'queued');
  assert.equal((await http(owner, file + url)).status, 409);
  let snapshotRead;
  const entered = new Promise(resolve => { snapshotRead = resolve; });
  let resume;
  const hold = new Promise(resolve => { resume = resolve; });
  const writer = createLedgerExportWorker({ pool: gatePool(async () => { snapshotRead(); await hold; }), jobs });
  const second = createLedgerExportWorker({ pool, jobs });
  const work = writer.tick();
  try {
    await Promise.race([entered, work.then(() => assert.fail('export worker did not open the expected SQL page'))]);
    await second.tick();
    assert.equal((await current()).state, 'running');
    const write = await jobs.executeCommand(owner.identity, { ...capture(owner), type: 'recharge', memberId: member.id, expectedAccountVersion: '5204', actualPayCents: '99' });
    assert.equal(write.balanceAfterCents, '5303');
    await jobs.updateMember(owner.identity, member.id, { name: '更名后', expectedVersion: '0' }, capture(owner));
  } finally { resume(); await work; await Promise.all([writer.close(), second.close()]); }
  const info = await current(); assert.equal(info.state, 'ready'); assert.equal(info.rows, 5203); assert.ok(info.snapshotAt);
  const downloaded = await http(owner, file + url);
  assert.equal(downloaded.status, 200); assert.equal(downloaded.headers.get('content-type'), XLSX_TYPE);
  assert.match(downloaded.headers.get('cache-control'), /no-store/);
  const bytes = Buffer.from(await downloaded.arrayBuffer()); assert.equal(bytes.length, Number(downloaded.headers.get('x-export-bytes')));
  const sheet = XLSX.read(bytes).Sheets[LEDGER_SHEET];
  assert.equal(sheet['!ref'], 'A1:O5204');
  assert.deepEqual([sheet.A2.v, sheet.A5204.v, sheet.C5204.v, sheet.C2.t, sheet.C2.f, sheet.F2.v, sheet.O2.v, sheet.O2.f],
    ['fixture-005203', 'fixture-000001', '=A1', 's', undefined, '0.01', '+备注', undefined]);
  const other = await loginStore('export-other', { ip: '127.0.0.2' });
  assert.equal(await current(other), null);
  await assert.rejects(jobs.downloadLedgerExport(other.identity, req.id, other), { code: 'EXPORT_NOT_FOUND' });
  const otherDevice = await loginStore('export-owner', { as: true, ip: '127.0.0.3' });
  assert.equal(await current(otherDevice), null);
  await assert.rejects(jobs.downloadLedgerExport(otherDevice.identity, req.id, otherDevice), { code: 'EXPORT_NOT_FOUND' });
  await service.createUser(owner.identity, { username: 'export-clerk', password, displayName: '验收员工', role: 'clerk' });
  const clerk = await loginStore('export-clerk', { as: true, ip: '127.0.0.4' });
  await assert.rejects(jobs.downloadLedgerExport(clerk.identity, req.id, clerk), { code: 'FORBIDDEN' });
  await service.logout(owner.identity);
  assert.equal((await http(owner, file + url)).status, 401);
  const events = (await pool.query("SELECT event FROM audit_events WHERE store_id=$1 AND event LIKE 'ledger_export%' ORDER BY id", [owner.storeId])).rows;
  assert.deepEqual(events.map(x => x.event), ['ledger_export_requested', 'ledger_export_download_authorized']);
});

for (const [count, note, result] of [[25000, '账', 'ready'], [25001, '账', 'EXPORT_ROW_LIMIT'], [1100, 'x'.repeat(8192), 'EXPORT_BYTES_LIMIT']]) {
  test('XLSX size boundaries: ' + result + ' (' + count + ' rows)', { timeout: 55000 }, async () => {
    await seed(owner, count, { note });
    const req = request(owner); await jobs.queueLedgerExport(owner.identity, req);
    const writer = createLedgerExportWorker({ pool, jobs });
    try { await writer.tick(); } finally { await writer.close(); }
    const info = await current();
    if (result === 'ready') {
      assert.equal(info.state, 'ready'); assert.equal(info.rows, LEDGER_EXPORT.rows);
      const data = await jobs.downloadLedgerExport(owner.identity, req.id, owner);
      assert.ok(data.length <= LEDGER_EXPORT.bytes);
      const sheet = XLSX.read(data, { dense: true }).Sheets[LEDGER_SHEET]; assert.equal(sheet['!ref'], 'A1:O25001');
    } else {
      assert.deepEqual([info.state, info.failure, info.rows], ['failed', result, null]);
      await assert.rejects(jobs.downloadLedgerExport(owner.identity, req.id, owner), { code: 'EXPORT_NOT_READY' });
    }
  });
}

test('queue allocation is bounded and original IDs deduplicate, with expired jobs freeing slots', { timeout: 30000 }, async () => {
  const req = request(owner);
  const duplicate = await Promise.all(Array.from({ length: 6 }, () => jobs.queueLedgerExport(owner.identity, req)));
  assert.ok(duplicate.every(x => x.id === req.id && x.expiresAt === duplicate[0].expiresAt));
  await assert.rejects(jobs.queueLedgerExport(owner.identity, { ...req, to: new Date(Date.parse(to) - 1000).toISOString() }), { code: 'EXPORT_ID_CONFLICT' });
  await assert.rejects(jobs.queueLedgerExport(owner.identity, request(owner)), { code: 'EXPORT_STORE_BUSY' });
  assert.throws(() => jobs.queueLedgerExport(owner.identity, { ...req, from: '2000-01-01T00:00:00Z' }), { code: 'EXPORT_RANGE_LIMIT' });
  const others = [];
  for (let i = 1; i <= LEDGER_EXPORT.slots; i++) others.push(await loginStore('export-store-' + i, { ip: '127.0.1.' + i }));
  for (const shop of others.slice(0, -1)) await jobs.queueLedgerExport(shop.identity, request(shop));
  const waiting = others.at(-1);
  await assert.rejects(jobs.queueLedgerExport(waiting.identity, request(waiting)), { code: 'EXPORT_QUEUE_FULL' });
  await pool.query("UPDATE ledger_export_jobs SET created_at=now()-interval '16 minutes',expires_at=now()-interval '1 minute' WHERE store_id=$1", [owner.storeId]);
  assert.equal(await current(), null);
  await jobs.queueLedgerExport(waiting.identity, request(waiting));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ledger_export_jobs')).rows[0].n, LEDGER_EXPORT.slots);
});

for (const kind of ['discard', 'new epoch', 'revoked session', 'worker disconnect']) {
  test('an export in progress survives safely: ' + kind, { timeout: 25000 }, async () => {
    await seed(owner, 2);
    const req = request(owner); await jobs.queueLedgerExport(owner.identity, req);
    const work = createLedgerExportWorker({ pool: gatePool(async client => {
      if (kind === 'discard') {
        assert.deepEqual(await jobs.discardLedgerExport(owner.identity, req.id, owner), { discarded: true });
        await jobs.queueLedgerExport(owner.identity, request(owner));
      } else if (kind === 'new epoch') await pool.query('UPDATE stores SET ledger_epoch=gen_random_uuid() WHERE id=$1', [owner.storeId]);
      else if (kind === 'revoked session') await service.logout(owner.identity);
      else {
        assert.equal((await pool.query('SELECT pg_terminate_backend($1) AS done', [client.processID])).rows[0].done, true);
        await delay(100);
      }
    }), jobs });
    try { await work.tick(); } finally { await work.close(); }
    const [{ state, artifact, failure } = {}] = (await pool.query('SELECT state,artifact,failure FROM ledger_export_jobs WHERE id=$1', [req.id])).rows;
    assert.equal(artifact ?? null, null);
    if (kind === 'discard') assert.equal(state, undefined);
    if (kind === 'new epoch') {
      await assert.rejects(jobs.downloadLedgerExport(owner.identity, req.id, owner), { code: 'LEDGER_EPOCH_MISMATCH' });
      const epoch = (await jobs.getBook(owner.identity)).ledgerEpoch;
      await assert.rejects(jobs.downloadLedgerExport(owner.identity, req.id, { ledgerEpoch: epoch }), { code: 'EXPORT_NOT_FOUND' });
    }
    if (kind === 'revoked session') assert.deepEqual([state, failure], ['failed', 'EXPORT_CONTEXT_CHANGED']);
    if (kind === 'worker disconnect') {
      assert.equal(state, 'running');
      const restarted = createLedgerExportWorker({ pool, jobs });
      try { await restarted.tick(); } finally { await restarted.close(); }
      assert.deepEqual([(await current()).id, (await current()).rows, (await current()).state], [req.id, 2, 'ready']);
    }
  });
}

