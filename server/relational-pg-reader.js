import { createHash } from 'node:crypto';
import { PG_BACKUP_TABLES, PG_BACKUP_KEYS, PG_AUDIT_FILTER } from './relational-backup.js';
import { backupEnsure as ensure } from '../src/relational-backup-rows.js';

// Identifiers below come exclusively from the code-owned backup whitelist.
// Values (including keyset boundaries) always remain bound parameters.
const refs = Object.entries(PG_BACKUP_TABLES).flatMap(([table, columns]) =>
  ['actor_id', 'imported_by', 'user_id'].filter(column => columns.includes(column)).map(column =>
    'SELECT ' + column + ' AS id FROM ' + table + ' WHERE store_id=$1' + (table === 'audit_events' ? PG_AUDIT_FILTER : ''))).join(' UNION ');
export const PG_ACTOR_REFERENCES = '(' + refs + ')';
export function pgProjection(table, columns = PG_BACKUP_TABLES[table]) {
  ensure(PG_BACKUP_TABLES[table] && columns?.every(column => PG_BACKUP_TABLES[table].includes(column)), '备份关系表或列不在白名单');
  return columns.map(column => column.endsWith('_at') ?
    'to_char(' + table + '.' + column + ' AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS ' + column :
    table + '.' + column + '::text AS ' + column).join(',');
}
export function postgresArchiveReader({ client, storeId, checkpoint = async () => {} }) {
  const fromStore = table => ' FROM ' + (table === 'actors' ? 'users AS actors' : table) + ' WHERE ' + table + '.store_id=$1' +
    (table === 'actors' ? ' AND actors.id IN (SELECT id FROM ' + PG_ACTOR_REFERENCES + ' AS referenced)' : table === 'audit_events' ? PG_AUDIT_FILTER : '');
  const orderBy = table => ' ORDER BY ' + PG_BACKUP_KEYS[table].map(column => table + '.' + column).join(',');
  async function* scanQuery(name, sql) {
    const cursor = 'archive_scan_' + name;
    // A restore has not been analyzed yet. Execute the ordered scan once so
    // the planner cannot choose a new whole-store scan for every LIMIT page.
    await client.query('DECLARE ' + cursor + ' NO SCROLL CURSOR FOR ' + sql, [storeId]);
    let failed = false;
    try {
      for (;;) {
        const { rows } = await client.query('FETCH FORWARD 200 FROM ' + cursor);
        await checkpoint();
        if (rows.length) yield rows;
        if (rows.length < 200) return;
      }
    } catch (error) { failed = true; throw error; }
    finally { if (!failed) await client.query('CLOSE ' + cursor); } // Rollback closes it after an error.
  }
  function scan(table) {
    ensure(PG_BACKUP_TABLES[table], '备份关系表不在白名单');
    return scanQuery(table, 'SELECT ' + pgProjection(table) + fromStore(table) + orderBy(table));
  }
  async function* pages(table, where = '', values = [], size = 200) {
    ensure(PG_BACKUP_TABLES[table] && Number.isInteger(size) && size >= 1 && size <= 200, '备份分页无效');
    let last;
    const order = PG_BACKUP_KEYS[table];
    for (;;) {
      const params = [storeId, ...values, ...(last ?? [])], offset = 2 + values.length;
      const after = last ? ' AND (' + order.map(column => table + '.' + column).join(',') + ')>(' + order.map((_, i) => '$' + (offset + i)).join(',') + ')' : '';
      const { rows } = await client.query('SELECT ' + pgProjection(table) + fromStore(table) + where + after + orderBy(table) + ' LIMIT ' + size, params);
      await checkpoint(); if (rows.length) yield rows; if (rows.length < size) break;
      last = order.map(column => rows.at(-1)[column]);
    }
  }
  async function collect(table, where, values, maximum) {
    const rows = [];
    for await (const page of pages(table, where, values)) { rows.push(...page); ensure(rows.length <= maximum, '备份关联记录超出领域上限'); }
    return rows;
  }
  async function byIds(table, column, ids, maximum) {
    ensure(PG_BACKUP_TABLES[table]?.includes(column), '备份关联列不在白名单');
    return ids.length ? collect(table, ' AND ' + table + '.' + column + '=ANY($2)', [ids], maximum) : [];
  }
  async function actorDigest() {
    const hash = createHash('sha256'); let count = 0, after = null;
    for (;;) {
      const { rows } = await client.query('SELECT r.id::text,u.store_id::text FROM ' + PG_ACTOR_REFERENCES + ' AS r LEFT JOIN users u ON u.id=r.id WHERE r.id IS NOT NULL' +
        (after === null ? '' : ' AND r.id>$2::uuid') + ' ORDER BY r.id LIMIT 200', [storeId, ...(after === null ? [] : [after])]);
      for (const row of rows) { ensure(row.store_id === storeId, '业务历史缺少同店操作人引用'); hash.update(row.id + '\n'); count++; }
      await checkpoint(); if (rows.length < 200) break; after = rows.at(-1).id;
    }
    return { count, digest: hash.digest('hex') };
  }
  return { scan, scanQuery, collect, byIds, actorDigest };
}
