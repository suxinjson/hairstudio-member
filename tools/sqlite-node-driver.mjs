import { DatabaseSync } from 'node:sqlite';

// Desktop verification driver. The Android bridge implements the same small
// interface; production browser bundles must never import node:sqlite.
export function openNodeSqlite(path) {
  return connection(path, false);
}
function connection(path, readOnly) {
  const database = new DatabaseSync(path, { readOnly });
  return {
    exec(sql) { database.exec(sql); },
    run(sql, parameters = []) { const statement = database.prepare(sql); statement.setReadBigInts(true); const result = statement.run(...parameters); return { changes: Number(result.changes), lastInsertRowid: String(result.lastInsertRowid) }; },
    all(sql, parameters = []) {
      const statement = database.prepare(sql); statement.setReadBigInts(true);
      return statement.all(...parameters).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? String(value) : value])));
    },
    openSnapshot() { if (readOnly || path === ':memory:') throw new Error('Independent file snapshot unavailable'); return connection(path, true); },
    close() { database.close(); }
  };
}
