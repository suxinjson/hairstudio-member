import { TASK_BACKUP_TABLES } from './relational-task-result-tables.js';
export { TASK_BACKUP_TABLES } from './relational-task-result-tables.js';
// Results are immutable relational snapshots. Reading an old task must return
// its original result even after the current profile or configuration changes.
export const SQLITE_TASK_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS local_task_receipts(store_id TEXT NOT NULL,task_id TEXT NOT NULL,request_hash TEXT NOT NULL,actor_id TEXT NOT NULL,device_id TEXT NOT NULL,task_type TEXT NOT NULL CHECK(task_type IN ('member.create','member.update','member.archive','configuration.update')),entity_id TEXT NOT NULL,completed_at TEXT NOT NULL,ledger_epoch TEXT NOT NULL,PRIMARY KEY(store_id,task_id))",
  'CREATE TABLE IF NOT EXISTS task_member_results(store_id TEXT NOT NULL,task_id TEXT NOT NULL,member_id TEXT NOT NULL,name TEXT NOT NULL,phone TEXT NOT NULL,notes TEXT NOT NULL,balance_cents INTEGER NOT NULL CHECK(typeof(balance_cents)=\'integer\'),profile_version INTEGER NOT NULL,account_version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT,PRIMARY KEY(store_id,task_id),FOREIGN KEY(store_id,task_id) REFERENCES local_task_receipts(store_id,task_id),FOREIGN KEY(store_id,member_id) REFERENCES member_profiles(store_id,id))',
  'CREATE TABLE IF NOT EXISTS task_member_tags(store_id TEXT NOT NULL,task_id TEXT NOT NULL,tag TEXT NOT NULL,PRIMARY KEY(store_id,task_id,tag),FOREIGN KEY(store_id,task_id) REFERENCES task_member_results(store_id,task_id))',
  'CREATE TABLE IF NOT EXISTS task_configuration_results(store_id TEXT NOT NULL,task_id TEXT NOT NULL,version INTEGER NOT NULL,gift_enabled INTEGER NOT NULL CHECK(gift_enabled IN (0,1)),gift_rate_basis_points INTEGER NOT NULL CHECK(gift_rate_basis_points BETWEEN 0 AND 10000),PRIMARY KEY(store_id,task_id),FOREIGN KEY(store_id,task_id) REFERENCES local_task_receipts(store_id,task_id))',
  'CREATE TABLE IF NOT EXISTS task_configuration_services(store_id TEXT NOT NULL,task_id TEXT NOT NULL,position INTEGER NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,price_cents INTEGER NOT NULL CHECK(typeof(price_cents)=\'integer\' AND price_cents>=0),PRIMARY KEY(store_id,task_id,id),UNIQUE(store_id,task_id,position),FOREIGN KEY(store_id,task_id) REFERENCES task_configuration_results(store_id,task_id))',
  'CREATE TABLE IF NOT EXISTS task_configuration_plans(store_id TEXT NOT NULL,task_id TEXT NOT NULL,position INTEGER NOT NULL,id TEXT NOT NULL,pay_cents INTEGER NOT NULL CHECK(typeof(pay_cents)=\'integer\' AND pay_cents>0),gift_cents INTEGER NOT NULL CHECK(typeof(gift_cents)=\'integer\' AND gift_cents>=0),PRIMARY KEY(store_id,task_id,id),UNIQUE(store_id,task_id,position),FOREIGN KEY(store_id,task_id) REFERENCES task_configuration_results(store_id,task_id))',
  ...['local_task_receipts', 'task_member_results', 'task_member_tags', 'task_configuration_results', 'task_configuration_services', 'task_configuration_plans'].flatMap(table => ['UPDATE', 'DELETE'].map(action => 'CREATE TRIGGER IF NOT EXISTS immutable_' + table + '_' + action.toLowerCase() + ' BEFORE ' + action + ' ON ' + table + " BEGIN SELECT RAISE(ABORT,'task result immutable'); END"))
];

export function sqliteTasks({ one, all, run, storeId }) {
  async function find(id) { return one('SELECT * FROM local_task_receipts WHERE store_id=? AND task_id=?', [storeId, id]); }
  async function read(row) {
    const params = [storeId, row.task_id];
    if (row.task_type === 'member.archive') return { success: true };
    if (row.task_type === 'configuration.update') {
      const settings = await one('SELECT * FROM task_configuration_results WHERE store_id=? AND task_id=?', params);
      const services = await all('SELECT id,name,price_cents FROM task_configuration_services WHERE store_id=? AND task_id=? ORDER BY position', params);
      const plans = await all('SELECT id,pay_cents,gift_cents FROM task_configuration_plans WHERE store_id=? AND task_id=? ORDER BY position', params);
      return { version: String(settings.version), services: services.map(item => ({ id: item.id, name: item.name, priceCents: String(item.price_cents) })), rechargePlans: plans.map(item => ({ id: item.id, payCents: String(item.pay_cents), giftCents: String(item.gift_cents) })), rechargeSettings: { giftEnabled: settings.gift_enabled === '1', giftRateBasisPoints: Number(settings.gift_rate_basis_points) } };
    }
    const profile = await one('SELECT * FROM task_member_results WHERE store_id=? AND task_id=?', params), tags = await all('SELECT tag FROM task_member_tags WHERE store_id=? AND task_id=? ORDER BY tag', params);
    return { id: profile.member_id, name: profile.name, phone: profile.phone, notes: profile.notes, tags: tags.map(item => item.tag), balanceCents: String(profile.balance_cents), version: String(profile.profile_version), accountVersion: String(profile.account_version), createdAt: profile.created_at, updatedAt: profile.updated_at, archivedAt: profile.archived_at };
  }
  async function save(request, requestHash, result, at) {
    await run('INSERT INTO local_task_receipts VALUES(?,?,?,?,?,?,?,?,?)', [storeId, request.id, requestHash, request.actorId, request.deviceId, request.type, request.memberId ?? result.id ?? 'store', at, request.ledgerEpoch]);
    if (request.type === 'member.archive') return;
    if (request.type === 'configuration.update') {
      await run('INSERT INTO task_configuration_results VALUES(?,?,?,?,?)', [storeId, request.id, result.version, result.rechargeSettings.giftEnabled ? '1' : '0', result.rechargeSettings.giftRateBasisPoints]);
      for (const [position, item] of result.services.entries()) await run('INSERT INTO task_configuration_services VALUES(?,?,?,?,?,?)', [storeId, request.id, position, item.id, item.name, item.priceCents]);
      for (const [position, item] of result.rechargePlans.entries()) await run('INSERT INTO task_configuration_plans VALUES(?,?,?,?,?,?)', [storeId, request.id, position, item.id, item.payCents, item.giftCents]);
      return;
    }
    await run('INSERT INTO task_member_results VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [storeId, request.id, result.id, result.name, result.phone, result.notes, result.balanceCents, result.version, result.accountVersion, result.createdAt, result.updatedAt, result.archivedAt]);
    for (const tag of result.tags) await run('INSERT INTO task_member_tags VALUES(?,?,?)', [storeId, request.id, tag]);
  }
  return { find, read, save };
}
