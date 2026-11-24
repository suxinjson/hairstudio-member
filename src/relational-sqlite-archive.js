import { ARCHIVE_LIMITS, archiveHeader, readRelationalArchive, writeRelationalArchive } from './relational-archive.js';
import { BACKUP_TABLES, validateBackupRow, backupEnsure as ensure } from './relational-backup-rows.js';
import { sqliteArchiveReader, validateSqliteArchiveDatabase } from './relational-sqlite-validation.js';
import { requireLedgerEpoch } from './ledger-epoch.js';
import { restoreCapture } from './relational-restore.js';

const conflict = (message, code) => Object.assign(new Error(message), { status: 409, code });
function notAborted(signal) { if (signal?.aborted) throw Object.assign(new Error('备份操作已取消'), { code: 'ARCHIVE_ABORTED' }); }

// No file paths or complete backup objects cross this application boundary.
// The caller owns the external byte source/sink and its independent read-back.
export function sqliteArchives({ storeId, mode, hash, now, transaction, book, all, run, identity, openSnapshot, checkRestore, findRestore, finishRestore }) {
  function standalone() { if (mode !== 'standalone') throw conflict('云端副本不能作为完整独立账本备份或恢复目标', 'WRONG_AUTHORITY'); }
  async function empty() {
    for (const table of Object.keys(BACKUP_TABLES)) if ((await all('SELECT 1 AS present FROM ' + table + ' LIMIT 1')).length) throw conflict('恢复须使用经过核对的新空账本', 'BACKUP_NOT_EMPTY');
  }
  async function importStream(input, preview) {
    standalone(); const captured = restoreCapture(input, { requireTask: !preview }), { chunks, signal } = input;
    return transaction('owner', 'importBackupData', async user => {
      notAborted(signal);
      if (!preview) { const prior = await findRestore(captured, user); if (prior) return prior; }
      await checkRestore(captured, user); await empty();
      const checkpoint = async () => {
        notAborted(signal); const current = await identity('owner', 'importBackupData');
        if (current.id !== user.id || current.deviceId !== user.deviceId) throw conflict('恢复期间账号或设备已变化', 'AUTH_CONTEXT_CHANGED');
      };
      const archive = await readRelationalArchive({ chunks, tables: BACKUP_TABLES, engine: 'sqlite', schemaVersion: 6, storeId, hash, validateRow: validateBackupRow, checkpoint,
        onRows: async (table, rows) => {
          const columns = BACKUP_TABLES[table], perInsert = Math.floor(120 / columns.length);
          for (let at = 0; at < rows.length; at += perInsert) {
            const group = rows.slice(at, at + perInsert);
            await run('INSERT INTO ' + table + '(' + columns.join(',') + ') VALUES' + group.map(() => '(' + columns.map(() => '?').join(',') + ')').join(','), group.flatMap(row => columns.map(column => row[column])));
          }
        } });
      if (!preview && archive.digest !== captured.digest) throw conflict('所选文件与已核对摘要不同', 'BACKUP_REVIEW_REQUIRED');
      const summary = await validateSqliteArchiveDatabase({ all, storeId, hash, checkpoint });
      for (const table of Object.keys(BACKUP_TABLES)) ensure(summary.rowCounts[table] === archive.rowCounts[table], '恢复数据库与文件记录数不符');
      await checkpoint();
      if (preview) return { ...summary, ...await book(), sourceLedgerEpoch: archive.header.ledgerEpoch, digest: archive.digest, byteLength: archive.byteLength, rowCount: archive.rowCount };
      return finishRestore(captured, user, archive.header.ledgerEpoch, summary);
    }, { rollbackOnly: preview });
  }
  return {
    async exportArchive({ write, signal } = {}) {
      standalone(); if (typeof write !== 'function') throw new Error('流式备份需要带背压的写入接口');
      const capture = await transaction('owner', 'exportBackupData', async user => ({ ...await book(), actorId: user.id, deviceId: user.deviceId }));
      const snapshot = await openSnapshot();
      try {
        await snapshot.exec('BEGIN');
        const rows = await snapshot.all('SELECT * FROM book_identity WHERE singleton=1'), row = rows[0];
        ensure(rows.length === 1 && row.store_id === storeId && row.mode === 'standalone' && String(row.schema_version) === '6', '备份快照归属或版本不同');
        requireLedgerEpoch(row.ledger_epoch, capture.ledgerEpoch);
        let ticks = 0;
        const checkpoint = async () => {
          notAborted(signal);
          // Yield to UI/timers even with a synchronous desktop verification driver.
          if (++ticks % 16 === 0) await new Promise(resolve => setTimeout(resolve, 0));
          await transaction('owner', 'exportBackupData', async user => {
            if (capture.actorId !== user.id || capture.deviceId !== user.deviceId) throw conflict('备份期间账号或设备已变化', 'AUTH_CONTEXT_CHANGED');
            requireLedgerEpoch(capture.ledgerEpoch, (await book()).ledgerEpoch);
          });
        };
        const read = (sql, params) => snapshot.all(sql, params), reader = sqliteArchiveReader({ all: read, storeId, checkpoint });
        const summary = await validateSqliteArchiveDatabase({ all: read, storeId, hash, checkpoint });
        const header = archiveHeader({ kind: 'header', format: 'member-relational-stream', formatVersion: 1, engine: 'sqlite', schemaVersion: 6,
          storeId, ledgerEpoch: capture.ledgerEpoch, exportedAt: now() }, { engine: 'sqlite', schemaVersion: 6, storeId });
        const result = await writeRelationalArchive({ header, tables: BACKUP_TABLES, readTable: table => reader.pages(table), write, hash, validateRow: validateBackupRow, checkpoint });
        await checkpoint(); return { ...result, memberCount: summary.memberCount, entryCount: summary.entryCount, storeId, ledgerEpoch: capture.ledgerEpoch, formatVersion: 1 };
      } finally { await snapshot.close(); }
    },
    previewArchiveRestore(input) { return importStream(input, true); },
    restoreArchive(input) { return importStream(input, false); },
    archiveLimits: ARCHIVE_LIMITS
  };
}
