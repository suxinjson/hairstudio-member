import { Worker } from 'node:worker_threads';
import { LEDGER_COLUMNS, LEDGER_EXPORT, ledgerSheetRow } from '../src/relational-export-sheet.js';
import { readSales } from './relational-sales.js';

const lock = '(739186,20261121)';
const pageSize = 200;
const failure = code => Object.assign(new Error(code), { code });
const permanentFailures = new Set(['EXPORT_ROW_LIMIT', 'EXPORT_BYTES_LIMIT', 'EXPORT_CONTEXT_CHANGED']);
const publishable = "j.store_id=$1 AND j.id=$2 AND j.state='running' AND j.expires_at>clock_timestamp() AND s.id=j.store_id AND s.ledger_epoch=j.ledger_epoch";

async function readSnapshot(client, job, signal) {
  // The date selection and its joined names, reversals, and sale lines must
  // agree at one point in time. Hold no store or session write locks here.
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='5s'");
    const { rows: [book] } = await client.query('SELECT ledger_epoch,statement_timestamp() AS at FROM stores WHERE id=$1', [job.store_id]);
    if (book?.ledger_epoch !== job.ledger_epoch) throw failure('EXPORT_CONTEXT_CHANGED');
    const rows = [LEDGER_COLUMNS]; let bytes = 0, last;
    for (;;) {
      signal.throwIfAborted();
      const args = [job.store_id, job.from_at, job.to_at, Math.min(pageSize, LEDGER_EXPORT.rows + 2 - rows.length)];
      if (last) args.push(last.page_at, last.entry_id);
      const page = (await client.query(
        'SELECT e.entry_id,e.member_id,e.kind,e.delta_cents,e.balance_before_cents,e.balance_after_cents,e.actual_pay_cents,e.gift_cents,' +
        'e.pay_method,e.items_summary,e.remark,e.occurred_at,e.occurred_at::text AS page_at,p.name,r.reversal_entry_id,o.original_entry_id ' +
        'FROM ledger_entries e JOIN member_profiles p ON (p.store_id,p.id)=(e.store_id,e.member_id) ' +
        'LEFT JOIN ledger_reversals r ON (r.store_id,r.original_entry_id)=(e.store_id,e.entry_id) ' +
        'LEFT JOIN ledger_reversals o ON (o.store_id,o.reversal_entry_id)=(e.store_id,e.entry_id) ' +
        'WHERE e.store_id=$1 AND e.occurred_at>=$2 AND e.occurred_at<$3 ' +
        (last ? 'AND (e.occurred_at,e.entry_id)<($5::timestamptz,$6::text) ' : '') +
        'ORDER BY e.occurred_at DESC,e.entry_id DESC LIMIT $4', args)).rows;
      signal.throwIfAborted();
      if (rows.length - 1 + page.length > LEDGER_EXPORT.rows) throw failure('EXPORT_ROW_LIMIT');
      const sales = await readSales(client, job.store_id, page.map(row => row.entry_id));
      for (const entry of page) {
        const row = ledgerSheetRow({ id: entry.entry_id, memberId: entry.member_id, memberName: entry.name, type: entry.kind, occurredAt: entry.occurred_at.toISOString(),
          deltaCents: String(entry.delta_cents), balanceBeforeCents: String(entry.balance_before_cents), balanceAfterCents: String(entry.balance_after_cents),
          actualPayCents: String(entry.actual_pay_cents), giftCents: String(entry.gift_cents), payMethod: entry.pay_method, itemsSummary: entry.items_summary,
          remark: entry.remark, originalEntryId: entry.original_entry_id, reversalEntryId: entry.reversal_entry_id, ...sales.get(entry.entry_id) });
        bytes += Buffer.byteLength(JSON.stringify(row));
        if (bytes > LEDGER_EXPORT.bytes) throw failure('EXPORT_BYTES_LIMIT');
        rows.push(row);
      }
      if (page.length < args[3]) break;
      last = page.at(-1);
    }
    signal.throwIfAborted();
    await client.query('COMMIT');
    return { rows, at: book.at };
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  }
}

async function encode(rows, signal) {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./relational-export-xlsx.js', import.meta.url), { workerData: rows, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 } });
  let abort;
  try {
    const message = await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      worker.once('message', resolve); worker.once('error', reject);
      worker.once('exit', () => reject(failure('EXPORT_FAILED')));
    });
    if (message.tooLarge) throw failure('EXPORT_BYTES_LIMIT');
    if (!(message.bytes instanceof Uint8Array) || !message.bytes.length || message.bytes.length > LEDGER_EXPORT.bytes) throw failure('EXPORT_FAILED');
    return Buffer.from(message.bytes.buffer, message.bytes.byteOffset, message.bytes.byteLength);
  } finally {
    signal.removeEventListener('abort', abort); await worker.terminate();
  }
}

async function build(client, jobs, job, shutdown) {
  const guard = new AbortController(), deadline = AbortSignal.timeout(LEDGER_EXPORT.timeoutMs);
  const signal = AbortSignal.any([shutdown, guard.signal, deadline]); let checking, timer;
  const checkLive = async () => {
    try { if (!await jobs.isLedgerExportRunning(job)) guard.abort(failure('EXPORT_CONTEXT_CHANGED')); }
    catch (error) { guard.abort(error); }
  };
  try {
    await jobs.authorizeLedgerExportJob(job);
    timer = setInterval(() => { if (!checking) checking = checkLive().finally(() => { checking = null; }); }, 1000);
    const { rows, at } = await readSnapshot(client, job, signal);
    await checkLive();
    const artifact = await encode(rows, signal);
    await jobs.authorizeLedgerExportJob(job, async authorizedClient => {
      signal.throwIfAborted();
      await authorizedClient.query("UPDATE ledger_export_jobs j SET state='ready',snapshot_at=$3,row_count=$4,artifact=$5 FROM stores s WHERE " + publishable,
        [job.store_id, job.id, at, rows.length - 1, artifact]);
    });
  } catch (error) {
    if (shutdown.aborted) return; // A new worker can pick up the running row.
    const code = deadline.aborted || error.code === '57014' ? 'EXPORT_TIMEOUT' : permanentFailures.has(error.code) ? error.code :
      [401, 403, 409].includes(error.status) ? 'EXPORT_CONTEXT_CHANGED' : 'EXPORT_FAILED';
    await client.query("UPDATE ledger_export_jobs j SET state='failed',failure=$3 FROM stores s WHERE " + publishable, [job.store_id, job.id, code]);
  } finally { clearInterval(timer); await checking; }
}

export function createLedgerExportWorker({ pool, jobs, onError = () => {} }) {
  let timer, running;
  const shutdown = new AbortController();
  async function next() {
    // Keep the session lock until encoding and publication finish. A crash
    // releases it; the next holder may restart a persisted running job.
    const client = await pool.connect(); let acquired = false, discard = false;
    const disconnected = new AbortController();
    const onError = error => { discard = true; disconnected.abort(error); };
    client.on('error', onError);
    try {
      ({ rows: [{ acquired }] } = await client.query('SELECT pg_try_advisory_lock' + lock + ' AS acquired'));
      if (!acquired || shutdown.signal.aborted) return;
      await client.query('DELETE FROM ledger_export_jobs j USING stores s WHERE s.id=j.store_id AND (j.expires_at<=clock_timestamp() OR s.ledger_epoch<>j.ledger_epoch)');
      const { rows: [job] } = await client.query("UPDATE ledger_export_jobs SET state='running' WHERE (slot,id)=(SELECT slot,id FROM ledger_export_jobs " +
        "WHERE state IN ('queued','running') AND expires_at>clock_timestamp() ORDER BY created_at,slot LIMIT 1 FOR UPDATE SKIP LOCKED) " +
        'RETURNING store_id,id,ledger_epoch,actor_id,device_id,session_id,from_at,to_at');
      if (job && !shutdown.signal.aborted) await build(client, jobs, job, AbortSignal.any([shutdown.signal, disconnected.signal]));
    } catch (error) { discard = true; throw error; }
    finally {
      if (acquired && !discard) {
        try { await client.query('SELECT pg_advisory_unlock' + lock); } catch { discard = true; }
      }
      client.off('error', onError); client.release(discard);
    }
  }
  function tick() {
    if (!running && !shutdown.signal.aborted) running = next().finally(() => { running = null; });
    return running;
  }
  function start() {
    if (timer || shutdown.signal.aborted) return;
    const poll = () => { void tick()?.catch(error => onError(error.code || 'EXPORT_WORKER_ERROR')); };
    timer = setInterval(poll, 3000); timer.unref(); poll();
  }
  return { tick, start, async close() { clearInterval(timer); shutdown.abort(); await running?.catch(() => {}); } };
}
