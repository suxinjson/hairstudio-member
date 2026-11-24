import { ApiError } from './security.js';
import { requireFeature } from './entitlements.js';
import { LEDGER_EPOCH, ledgerEpochOf, requireLedgerEpoch } from '../src/ledger-epoch.js';
import { reportPeriod } from '../src/relational-reports.js';
import { LEDGER_EXPORT } from '../src/relational-export-sheet.js';

const fields = 'id,ledger_epoch,from_at,to_at,expires_at,state,snapshot_at,row_count,failure';
const currentJob = 'store_id=$1 AND ledger_epoch=$2 AND actor_id=$3 AND device_id=$4 AND expires_at>clock_timestamp()';
const argsFor = user => [user.store_id, user.ledger_epoch, user.id, user.device_id];
const iso = value => new Date(value).toISOString();
const describe = row => row ? { id: row.id, ledgerEpoch: row.ledger_epoch, from: iso(row.from_at), to: iso(row.to_at), expiresAt: iso(row.expires_at),
  state: row.state, snapshotAt: row.snapshot_at ? iso(row.snapshot_at) : null, rows: row.row_count, failure: row.failure } : null;

function exportId(value) {
  if (typeof value !== 'string' || !LEDGER_EPOCH.test(value)) throw new ApiError(400, '导出任务号无效', 'INVALID_INPUT');
  return value;
}
function exportGate(ledgerEpoch, user) {
  requireLedgerEpoch(ledgerEpoch, user.ledger_epoch);
  requireFeature(user.entitlements, 'cashier');
}

export function createLedgerExportJobs({ pool, withAuthorized, audit }) {
  return {
    queueLedgerExport(identity, input) {
      const id = exportId(input?.id), epoch = ledgerEpochOf(input?.ledgerEpoch), { from, to } = reportPeriod(input);
      if (Date.parse(to) - Date.parse(from) > LEDGER_EXPORT.days * 86400000) throw new ApiError(400, '导出最多选择 366 天', 'EXPORT_RANGE_LIMIT');
      return withAuthorized(identity, 'owner', async (client, user) => {
        exportGate(epoch, user);
        // Serialize bounded slot allocation across API processes. This lock is
        // never held by the XLSX writer or by a financial command.
        await client.query('SELECT pg_advisory_xact_lock(739186,20261120)');
        await client.query('DELETE FROM ledger_export_jobs WHERE expires_at<=clock_timestamp() OR (store_id=$1 AND ledger_epoch<>$2)', [user.store_id, epoch]);
        const { rows: [existing] } = await client.query('SELECT ' + fields + ',actor_id,device_id,session_id FROM ledger_export_jobs WHERE store_id=$1 FOR UPDATE', [user.store_id]);
        if (existing) {
          if (existing.id !== id || existing.actor_id !== user.id || existing.device_id !== user.device_id) throw new ApiError(409, '本门店已有导出任务，请先清除或等待它过期', 'EXPORT_STORE_BUSY');
          if (iso(existing.from_at) !== from || iso(existing.to_at) !== to) throw new ApiError(409, '导出任务号已用于其他区间', 'EXPORT_ID_CONFLICT');
          if (existing.session_id !== identity.sessionId) throw new ApiError(409, '请先清除原会话的任务，再建立新任务', 'EXPORT_SESSION_CHANGED');
          return describe(existing);
        }
        const { rows: [saved] } = await client.query(
          "INSERT INTO ledger_export_jobs(slot,store_id,ledger_epoch,actor_id,device_id,id,session_id,from_at,to_at,expires_at) " +
          "SELECT s.slot,$1,$2,$3,$4,$5,$6,$7,$8,now()+$9::int*interval '1 minute' FROM generate_series(1,$10::int) AS s(slot) " +
          'WHERE NOT EXISTS(SELECT 1 FROM ledger_export_jobs j WHERE j.slot=s.slot) ORDER BY s.slot LIMIT 1 RETURNING ' + fields,
        [...argsFor(user), id, identity.sessionId, from, to, LEDGER_EXPORT.minutes, LEDGER_EXPORT.slots]);
        if (!saved) throw new ApiError(429, '导出任务已满，请稍后重试', 'EXPORT_QUEUE_FULL');
        await audit(client, user, 'ledger_export_requested', { exportId: id, from, to });
        return describe(saved);
      });
    },
    getLedgerExport(identity, { ledgerEpoch } = {}) {
      ledgerEpochOf(ledgerEpoch);
      return withAuthorized(identity, 'owner', async (client, user) => {
        exportGate(ledgerEpoch, user);
        return describe((await client.query('SELECT ' + fields + ' FROM ledger_export_jobs WHERE ' + currentJob, argsFor(user))).rows[0]);
      });
    },
    discardLedgerExport(identity, id, { ledgerEpoch } = {}) {
      exportId(id); ledgerEpochOf(ledgerEpoch);
      return withAuthorized(identity, 'owner', async (client, user) => {
        exportGate(ledgerEpoch, user);
        const { rows } = await client.query('DELETE FROM ledger_export_jobs WHERE ' + currentJob + ' AND id=$5 RETURNING id', [...argsFor(user), id]);
        if (rows.length) await audit(client, user, 'ledger_export_discarded', { exportId: id });
        return { discarded: rows.length > 0 };
      });
    },
    async downloadLedgerExport(identity, id, { ledgerEpoch } = {}) {
      exportId(id); ledgerEpochOf(ledgerEpoch);
      return withAuthorized(identity, 'owner', async (client, user) => {
        exportGate(ledgerEpoch, user);
        const { rows: [row] } = await client.query('SELECT state,artifact,row_count FROM ledger_export_jobs WHERE ' + currentJob + ' AND id=$5', [...argsFor(user), id]);
        if (!row) throw new ApiError(404, '未找到当前身份下的导出文件，任务可能已过期', 'EXPORT_NOT_FOUND');
        if (row.state !== 'ready') throw new ApiError(409, '导出文件尚不可下载', 'EXPORT_NOT_READY');
        await audit(client, user, 'ledger_export_download_authorized', { exportId: id, rows: row.row_count });
        return row.artifact;
      });
    },
    async authorizeLedgerExportJob(job, publish = async () => {}) {
      await withAuthorized({ store_id: job.store_id, id: job.actor_id, sessionId: job.session_id }, 'owner', async (client, user) => {
        exportGate(job.ledger_epoch, user);
        if (user.device_id !== job.device_id) throw new ApiError(403, '导出任务的设备已变化', 'FORBIDDEN');
        await publish(client);
      });
    },
    async isLedgerExportRunning(job) {
      const { rowCount } = await pool.query('SELECT 1 FROM ledger_export_jobs j JOIN stores s ON s.id=j.store_id AND s.ledger_epoch=j.ledger_epoch ' +
        "WHERE j.store_id=$1 AND j.id=$2 AND j.state='running' AND j.expires_at>clock_timestamp()", [job.store_id, job.id]);
      return rowCount > 0;
    }
  };
}
