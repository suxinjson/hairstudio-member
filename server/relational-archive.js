import { createHash, randomUUID } from 'node:crypto';
import { ApiError, digest } from './security.js';
import { requireFeature } from './entitlements.js';
import { PG_BACKUP_TABLES, emptyTarget, summaryResult, validatePostgresRow } from './relational-backup.js';
import { postgresArchiveReader } from './relational-pg-reader.js';
import { validatePostgresArchiveDatabase } from './relational-pg-validation.js';
import { ARCHIVE_LIMITS, archiveHeader, readRelationalArchive, writeRelationalArchive } from '../src/relational-archive.js';
import { backupEnsure as ensure } from '../src/relational-backup-rows.js';
import { ledgerEpochOf, requireLedgerEpoch } from '../src/ledger-epoch.js';
import { COMMAND_ID } from '../src/relational-contract.js';

export const PG_ARCHIVE_TIMEOUTS = Object.freeze({ totalMs: 10 * 60 * 1000, idleMs: 15000 });
const abortError = () => new ApiError(408, '流式备份已取消或传输超时', 'ARCHIVE_ABORTED');

// The outer deadline includes authorization, validation and transfer. A slow
// or stalled source/sink cannot hold store/auth locks indefinitely. SQL still
// uses the pool's statement/lock timeouts; no unsafe concurrent ROLLBACK/query.
export function archiveLifetime(signal, { totalMs, idleMs } = PG_ARCHIVE_TIMEOUTS) {
  const controller = new AbortController(), total = setTimeout(() => controller.abort(), totalMs); total.unref?.();
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const check = user => {
    if (controller.signal.aborted) throw abortError();
    if (user?.session_expires_at && Date.parse(user.session_expires_at) <= Date.now()) throw new ApiError(401, '登录已失效，请重新登录', 'AUTH_REQUIRED');
    if (user?.entitlements.expiresAt && Date.parse(user.entitlements.expiresAt) <= Date.now()) throw new ApiError(403, '门店授权已到期', 'LICENSE_EXPIRED');
  };
  async function wait(work) {
    check(); let timer, stop;
    const cancelled = new Promise((_, reject) => {
      stop = () => reject(abortError()); controller.signal.addEventListener('abort', stop, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(abortError()); }, idleMs); timer.unref?.();
    });
    try { return await Promise.race([Promise.resolve().then(work), cancelled]); }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', stop); }
  }
  async function* chunks(source) {
    ensure(source && typeof source[Symbol.asyncIterator] === 'function', '恢复需要有界字节流');
    const iterator = source[Symbol.asyncIterator](); let completed = false;
    try { for (;;) { const next = await wait(() => iterator.next()); if (next.done) { completed = true; break; } yield next.value; } }
    finally { if (!completed && iterator.return) { try { Promise.resolve(iterator.return()).catch(() => {}); } catch {} } }
  }
  return { check, wait, chunks, close() { clearTimeout(total); signal?.removeEventListener('abort', abort); } };
}
function capture(input, preview) {
  const { chunks, signal, ...request } = input ?? {}, keys = preview ? ['id', 'ledgerEpoch'] : ['id', 'ledgerEpoch', 'sourceEpoch', 'reviewedDigest'];
  ensure(Object.keys(request).length === keys.length && keys.every(key => Object.hasOwn(request, key)) && typeof request.id === 'string' && COMMAND_ID.test(request.id), '流式恢复任务请求无效');
  ledgerEpochOf(request.ledgerEpoch);
  if (!preview) { ledgerEpochOf(request.sourceEpoch); ensure(typeof request.reviewedDigest === 'string' && /^[a-f0-9]{64}$/.test(request.reviewedDigest), '须提交原预览摘要'); }
  return { request: { ...request }, chunks, signal };
}

export function createArchiveService({ withAuthorized, audit }) {
  function checkpoints(client, user, life) {
    let heartbeat = Date.now();
    return async () => {
      life.check(user);
      // A slow sink may split one fetched page into many frames. Keep the
      // existing snapshot transaction alive, without claiming a fresh view of
      // revocation (its authorization rows remain share-locked until finish).
      if (Date.now() - heartbeat >= 5000) { await client.query('SELECT 1'); heartbeat = Date.now(); life.check(user); }
    };
  }
  async function importArchive(identity, input, preview) {
    // Bind primitive metadata before any await. Byte sources are consumed once;
    // the chained footer digest binds the original preview to the final import.
    const { request, chunks, signal } = capture(input, preview), life = archiveLifetime(signal);
    try {
      return await withAuthorized(identity, 'owner', async (client, user) => {
        requireFeature(user.entitlements, 'backup'); const checkpoint = checkpoints(client, user, life); await checkpoint();
        if (!preview) {
          const { rows: [prior] } = await client.query('SELECT * FROM ledger_restore_receipts WHERE store_id=$1 AND task_id=$2', [user.store_id, request.id]);
          if (prior) {
            if (prior.actor_id !== user.id || prior.device_id !== user.device_id || prior.target_epoch !== request.ledgerEpoch || prior.source_digest !== request.reviewedDigest || prior.source_epoch !== request.sourceEpoch) throw new ApiError(409, '恢复任务号已绑定其他内容或身份', 'RESTORE_TASK_CONFLICT');
            return summaryResult(prior);
          }
        }
        requireLedgerEpoch(request.ledgerEpoch, user.ledger_epoch); await emptyTarget(client, user.store_id);
        const actorHash = createHash('sha256'); let actorCount = 0, missing = 0, lastActor, previousTable;
        const archive = await readRelationalArchive({ chunks: life.chunks(chunks), tables: PG_BACKUP_TABLES, engine: 'postgres', schemaVersion: 2, storeId: user.store_id, hash: digest, validateRow: validatePostgresRow, checkpoint,
          onHeader: async header => { if (!preview) ensure(header.ledgerEpoch === request.sourceEpoch, '来源代际与原预览不符'); },
          onRows: async (table, rows) => {
            await checkpoint();
            if (previousTable === 'ledger_entries' && table !== previousTable) await client.query('SELECT refresh_recovery_statistics()');
            previousTable = table;
            if (table === 'actors') {
              const { rows: existing } = await client.query('SELECT id::text,store_id::text FROM users WHERE id=ANY($1::uuid[])', [rows.map(row => row.id)]);
              if (existing.some(row => row.store_id !== user.store_id)) throw new ApiError(409, '历史操作人标识已属于其他门店，禁止自动映射', 'RESTORE_ACTOR_CONFLICT');
              const present = new Set(existing.map(row => row.id));
              for (const row of rows) {
                ensure(lastActor === undefined || row.id > lastActor, '历史操作人须按原标识严格递增'); lastActor = row.id; actorHash.update(row.id + '\n'); actorCount++;
                if (!present.has(row.id)) { missing++; await client.query("INSERT INTO users(id,store_id,username,display_name,password_hash,role,active,historical_only,created_at) VALUES($1,$2,$3,$4,'!restored-history-no-password','viewer',false,true,$5)", [row.id, user.store_id, '~history~' + row.id, row.display_name, row.created_at]); }
              }
              return;
            }
            if (table === 'ledger_restore_receipts') ensure(!rows.some(row => row.task_id === request.id), '恢复任务号与来源历史重复');
            // Frames already cap this at 200 validated rows and 512 KiB.
            // One bounded insert per frame avoids SQL round trips per 1000
            // parameters; the whitelist has far fewer than PG's bind limit.
            const columns = PG_BACKUP_TABLES[table], conflict = table === 'store_recharge_settings' ? ' ON CONFLICT(store_id) DO UPDATE SET ' + columns.filter(column => column !== 'store_id').map(column => column + '=EXCLUDED.' + column).join(',') : '';
            const values = rows.flatMap(row => columns.map(column => row[column]));
            await client.query('INSERT INTO ' + table + '(' + columns.join(',') + ') VALUES' + rows.map((_, index) => '(' + columns.map((_, column) => '$' + (index * columns.length + column + 1)).join(',') + ')').join(',') + conflict, values);
          } });
        if (!preview) ensure(archive.digest === request.reviewedDigest, '文件摘要与原预览不符');
        await client.query('SELECT refresh_recovery_statistics()');
        await checkpoint();
        const summary = await validatePostgresArchiveDatabase({ client, storeId: user.store_id, hash: digest, checkpoint });
        ensure(actorCount === summary.actors.count && actorHash.digest('hex') === summary.actors.digest, '历史操作人引用不完整或含多余身份');
        for (const table of Object.keys(PG_BACKUP_TABLES)) ensure(summary.rowCounts[table] === archive.rowCounts[table] || table === 'store_recharge_settings' && archive.rowCounts[table] === 0 && summary.rowCounts[table] === 1, '恢复数据库与文件记录数不符');
        await checkpoint();
        if (preview) return { taskId: request.id, sourceDigest: archive.digest, sourceEpoch: archive.header.ledgerEpoch, targetEpoch: user.ledger_epoch, memberCount: summary.memberCount, entryCount: summary.entryCount, historicalActorCount: missing, byteLength: archive.byteLength, rowCount: archive.rowCount };
        let epoch; do { epoch = randomUUID(); } while ([archive.header.ledgerEpoch, user.ledger_epoch].includes(epoch));
        await client.query('UPDATE stores SET ledger_epoch=$1 WHERE id=$2', [epoch, user.store_id]);
        const result = { store_id: user.store_id, task_id: request.id, actor_id: user.id, device_id: user.device_id, target_epoch: user.ledger_epoch, source_epoch: archive.header.ledgerEpoch,
          restored_epoch: epoch, source_digest: archive.digest, member_count: String(summary.memberCount), entry_count: String(summary.entryCount), completed_at: new Date().toISOString() };
        const columns = PG_BACKUP_TABLES.ledger_restore_receipts;
        await client.query('INSERT INTO ledger_restore_receipts(' + columns.join(',') + ') VALUES(' + columns.map((_, index) => '$' + (index + 1)).join(',') + ')', columns.map(column => result[column]));
        await audit(client, user, 'ledger_restored', { taskId: request.id, sourceDigest: archive.digest, sourceEpoch: archive.header.ledgerEpoch, targetEpoch: user.ledger_epoch, ledgerEpoch: epoch, memberCount: summary.memberCount, entryCount: summary.entryCount });
        return summaryResult(result);
      }, { exclusiveStore: true, recovery: true, rollbackOnly: preview });
    } finally { life.close(); }
  }
  return {
    async exportArchive(identity, { write, signal } = {}) {
      ensure(typeof write === 'function', '导出需要带背压的字节写入接口'); const life = archiveLifetime(signal);
      try {
        return await withAuthorized(identity, 'owner', async (client, user) => {
          requireFeature(user.entitlements, 'backup'); const checkpoint = checkpoints(client, user, life); await checkpoint();
          const reader = postgresArchiveReader({ client, storeId: user.store_id, checkpoint });
          const summary = await validatePostgresArchiveDatabase({ client, storeId: user.store_id, hash: digest, checkpoint });
          const header = archiveHeader({ kind: 'header', format: 'member-relational-stream', formatVersion: 1, engine: 'postgres', schemaVersion: 2, storeId: user.store_id, ledgerEpoch: user.ledger_epoch, exportedAt: new Date().toISOString() }, { engine: 'postgres', schemaVersion: 2, storeId: user.store_id });
          const result = await writeRelationalArchive({ header, tables: PG_BACKUP_TABLES, readTable: table => reader.scan(table), write: line => life.wait(() => write(line)), hash: digest, validateRow: validatePostgresRow, checkpoint });
          await checkpoint(); return { ...result, memberCount: summary.memberCount, entryCount: summary.entryCount, ledgerEpoch: user.ledger_epoch, storeId: user.store_id };
        }, { consistentRead: true });
      } finally { life.close(); }
    },
    previewArchiveRestore(identity, input) { return importArchive(identity, input, true); },
    restoreArchive(identity, input) { return importArchive(identity, input, false); },
    archiveLimits: ARCHIVE_LIMITS
  };
}
