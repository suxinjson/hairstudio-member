import { Capacitor, registerPlugin } from '@capacitor/core';

const bridge = registerPlugin('RelationalSqlite');
export async function openAndroidSqlite({ plugin = bridge, native = Capacitor.isNativePlatform() } = {}) {
  if (!native) throw new Error('Android SQLite 只能在原生设备上打开');
  await plugin.open(); let closed = false, opening = false;
  const snapshots = new Set();
  function parameters(values = []) {
    return values.map(value => {
      if (value === null || typeof value === 'string') return value;
      if (typeof value === 'bigint' || typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
      throw new Error('SQLite 绑定值只接受文本、整数或 null');
    });
  }
  function check() { if (closed) throw new Error('Android SQLite 已关闭'); }
  function rows(result) {
    if (!Array.isArray(result?.rows) || result.rows.length > 1000 || result.rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) || Object.values(row).some(value => value !== null && typeof value !== 'string'))) throw new Error('SQLite 查询响应无效');
    return result.rows;
  }
  return {
    async exec(sql) { check(); await plugin.exec({ sql }); },
    async run(sql, values) { check(); return plugin.run({ sql, parameters: parameters(values) }); },
    async all(sql, values) { check(); return rows(await plugin.all({ sql, parameters: parameters(values) })); },
    async openSnapshot() {
      check();
      if (opening || snapshots.size) throw new Error('已有 SQLite 快照正在运行');
      opening = true;
      try {
        const { token } = await plugin.openSnapshot();
        if (typeof token !== 'string' || !/^[a-f0-9-]{36}$/.test(token)) throw new Error('SQLite 快照响应无效');
        if (closed) { await plugin.closeSnapshot({ token }).catch(() => {}); throw new Error('Android SQLite 已关闭'); }
        let done = false;
        const active = () => { check(); if (done) throw new Error('SQLite 快照已关闭'); };
        const snapshot = {
          async exec(sql) { active(); if (sql !== 'BEGIN') throw new Error('快照仅接受只读事务'); await plugin.snapshotExec({ token, sql }); },
          async all(sql, values) { active(); return rows(await plugin.snapshotAll({ token, sql, parameters: parameters(values) })); },
          async close() { if (!done) { done = true; snapshots.delete(snapshot); await plugin.closeSnapshot({ token }); } }
        };
        snapshots.add(snapshot); return snapshot;
      } finally { opening = false; }
    },
    async close() {
      if (!closed) {
        closed = true;
        try { await Promise.all([...snapshots].map(snapshot => snapshot.close())); } finally { await plugin.close(); }
      }
    }
  };
}
