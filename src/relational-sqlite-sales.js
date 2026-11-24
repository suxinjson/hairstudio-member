import { emptyConfiguration } from './relational-sales.js';

export const SQLITE_SALES_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS local_command_configurations(store_id TEXT NOT NULL,command_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version>=0),PRIMARY KEY(store_id,command_id),FOREIGN KEY(store_id,command_id) REFERENCES command_receipts(store_id,command_id))",
  "CREATE TABLE IF NOT EXISTS service_catalog(store_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,price_cents INTEGER NOT NULL CHECK(typeof(price_cents)='integer' AND price_cents>=0),position INTEGER NOT NULL,active INTEGER NOT NULL CHECK(active IN (0,1)),PRIMARY KEY(store_id,id))",
  "CREATE TABLE IF NOT EXISTS recharge_plan_items(store_id TEXT NOT NULL,id TEXT NOT NULL,pay_cents INTEGER NOT NULL CHECK(typeof(pay_cents)='integer' AND pay_cents>0),gift_cents INTEGER NOT NULL CHECK(typeof(gift_cents)='integer' AND gift_cents>=0),position INTEGER NOT NULL,active INTEGER NOT NULL CHECK(active IN (0,1)),PRIMARY KEY(store_id,id))",
  "CREATE TABLE IF NOT EXISTS store_recharge_settings(store_id TEXT PRIMARY KEY,version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version>=0),gift_enabled INTEGER NOT NULL CHECK(gift_enabled IN (0,1)),gift_rate_basis_points INTEGER NOT NULL CHECK(gift_rate_basis_points BETWEEN 0 AND 10000))",
  "CREATE TABLE IF NOT EXISTS consumption_items(store_id TEXT NOT NULL,entry_id TEXT NOT NULL,position INTEGER NOT NULL,service_id TEXT,name TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 9999),unit_price_cents INTEGER NOT NULL CHECK(typeof(unit_price_cents)='integer' AND unit_price_cents>=0),line_total_cents INTEGER NOT NULL CHECK(typeof(line_total_cents)='integer' AND line_total_cents>=0 AND line_total_cents=unit_price_cents*quantity),PRIMARY KEY(store_id,entry_id,position),FOREIGN KEY(store_id,entry_id) REFERENCES ledger_entries(store_id,entry_id))",
  "CREATE TABLE IF NOT EXISTS payment_records(store_id TEXT NOT NULL,entry_id TEXT NOT NULL,position INTEGER NOT NULL,method TEXT NOT NULL,amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),PRIMARY KEY(store_id,entry_id,position),FOREIGN KEY(store_id,entry_id) REFERENCES ledger_entries(store_id,entry_id))",
  "CREATE TABLE IF NOT EXISTS recharge_details(store_id TEXT NOT NULL,entry_id TEXT NOT NULL,configuration_version INTEGER NOT NULL CHECK(typeof(configuration_version)='integer' AND configuration_version>=0),plan_id TEXT,actual_pay_cents INTEGER NOT NULL CHECK(typeof(actual_pay_cents)='integer' AND actual_pay_cents>0),gift_cents INTEGER NOT NULL CHECK(typeof(gift_cents)='integer' AND gift_cents>=0),gift_enabled INTEGER NOT NULL CHECK(gift_enabled IN (0,1) AND (gift_enabled=1 OR gift_cents=0)),gift_rate_basis_points INTEGER NOT NULL CHECK(gift_rate_basis_points BETWEEN 0 AND 10000),PRIMARY KEY(store_id,entry_id),FOREIGN KEY(store_id,entry_id) REFERENCES ledger_entries(store_id,entry_id))",
  'CREATE TABLE IF NOT EXISTS sync_outbox_sale(store_id TEXT NOT NULL,command_id TEXT NOT NULL,configuration_version INTEGER,plan_id TEXT,has_items INTEGER NOT NULL,has_payments INTEGER NOT NULL,PRIMARY KEY(store_id,command_id),FOREIGN KEY(store_id,command_id) REFERENCES sync_outbox(store_id,command_id) ON DELETE CASCADE)',
  'CREATE TABLE IF NOT EXISTS sync_outbox_items(store_id TEXT NOT NULL,command_id TEXT NOT NULL,position INTEGER NOT NULL,service_id TEXT,name TEXT NOT NULL,quantity INTEGER NOT NULL,unit_price_cents INTEGER NOT NULL,PRIMARY KEY(store_id,command_id,position),FOREIGN KEY(store_id,command_id) REFERENCES sync_outbox(store_id,command_id) ON DELETE CASCADE)',
  'CREATE TABLE IF NOT EXISTS sync_outbox_payments(store_id TEXT NOT NULL,command_id TEXT NOT NULL,position INTEGER NOT NULL,method TEXT NOT NULL,amount_cents INTEGER NOT NULL,PRIMARY KEY(store_id,command_id,position),FOREIGN KEY(store_id,command_id) REFERENCES sync_outbox(store_id,command_id) ON DELETE CASCADE)',
  ...['consumption_items', 'payment_records', 'recharge_details', 'command_receipts', 'local_command_configurations', 'account_opening_batches', 'ledger_reversals', 'local_audit'].flatMap(table => ['UPDATE', 'DELETE'].map(operation => `CREATE TRIGGER IF NOT EXISTS immutable_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'history immutable'); END`))
];

export function sqliteSales({ all, one, run, storeId }) {
  async function configuration() {
    const settings = await one('SELECT * FROM store_recharge_settings WHERE store_id=?', [storeId]); if (!settings) return emptyConfiguration();
    const services = await all('SELECT * FROM service_catalog WHERE store_id=? AND active=1 ORDER BY position,id', [storeId]);
    const plans = await all('SELECT * FROM recharge_plan_items WHERE store_id=? AND active=1 ORDER BY position,id', [storeId]);
    return { version: String(settings.version), services: services.map(row => ({ id: row.id, name: row.name, priceCents: String(row.price_cents) })),
      rechargePlans: plans.map(row => ({ id: row.id, payCents: String(row.pay_cents), giftCents: String(row.gift_cents) })), rechargeSettings: { giftEnabled: String(settings.gift_enabled) === '1', giftRateBasisPoints: Number(settings.gift_rate_basis_points) } };
  }
  async function saveConfiguration(data) {
    await run('INSERT OR IGNORE INTO store_recharge_settings VALUES(?,?,?,?)', [storeId, data.version, data.rechargeSettings.giftEnabled ? 1 : 0, data.rechargeSettings.giftRateBasisPoints]);
    await run('UPDATE store_recharge_settings SET version=?,gift_enabled=?,gift_rate_basis_points=? WHERE store_id=?', [data.version, data.rechargeSettings.giftEnabled ? 1 : 0, data.rechargeSettings.giftRateBasisPoints, storeId]);
    await run('UPDATE service_catalog SET active=0 WHERE store_id=?', [storeId]);
    await run('UPDATE recharge_plan_items SET active=0 WHERE store_id=?', [storeId]);
    for (const [position, row] of data.services.entries()) {
      await run('INSERT OR IGNORE INTO service_catalog VALUES(?,?,?,?,?,1)', [storeId, row.id, row.name, row.priceCents, position]);
      await run('UPDATE service_catalog SET name=?,price_cents=?,position=?,active=1 WHERE store_id=? AND id=?', [row.name, row.priceCents, position, storeId, row.id]);
    }
    for (const [position, row] of data.rechargePlans.entries()) {
      await run('INSERT OR IGNORE INTO recharge_plan_items VALUES(?,?,?,?,?,1)', [storeId, row.id, row.payCents, row.giftCents, position]);
      await run('UPDATE recharge_plan_items SET pay_cents=?,gift_cents=?,position=?,active=1 WHERE store_id=? AND id=?', [row.payCents, row.giftCents, position, storeId, row.id]);
    }
  }
  async function write(entryId, sale) {
    for (const [position, row] of sale.items.entries()) await run('INSERT INTO consumption_items VALUES(?,?,?,?,?,?,?,?)', [storeId, entryId, position, row.serviceId, row.name, row.quantity, row.unitPriceCents, row.lineTotalCents]);
    for (const [position, row] of sale.payments.entries()) await run('INSERT INTO payment_records VALUES(?,?,?,?,?)', [storeId, entryId, position, row.method, row.amountCents]);
    if (sale.recharge) { const row = sale.recharge; await run('INSERT INTO recharge_details VALUES(?,?,?,?,?,?,?,?)', [storeId, entryId, row.configurationVersion, row.planId, row.actualPayCents, row.giftCents, row.giftEnabled ? 1 : 0, row.giftRateBasisPoints]); }
  }
  async function read(ids) {
    const result = new Map(ids.map(id => [id, { items: [], payments: [], recharge: null }])); if (!ids.length) return result;
    // A sale may have 100 lines. A 25-entry screen can exceed the Android bridge's 1,000-row cap.
    for (let offset = 0; offset < ids.length; offset += 8) {
    const part = ids.slice(offset, offset + 8), placeholders = part.map(() => '?').join(','), params = [storeId, ...part];
    for (const row of await all(`SELECT * FROM consumption_items WHERE store_id=? AND entry_id IN (${placeholders}) ORDER BY entry_id,position`, params)) result.get(row.entry_id).items.push({ serviceId: row.service_id, name: row.name, quantity: Number(row.quantity), unitPriceCents: String(row.unit_price_cents), lineTotalCents: String(row.line_total_cents) });
    for (const row of await all(`SELECT * FROM payment_records WHERE store_id=? AND entry_id IN (${placeholders}) ORDER BY entry_id,position`, params)) result.get(row.entry_id).payments.push({ method: row.method, amountCents: String(row.amount_cents) });
    for (const row of await all(`SELECT * FROM recharge_details WHERE store_id=? AND entry_id IN (${placeholders})`, params)) result.get(row.entry_id).recharge = { configurationVersion: String(row.configuration_version), planId: row.plan_id, actualPayCents: String(row.actual_pay_cents), giftCents: String(row.gift_cents), giftEnabled: String(row.gift_enabled) === '1', giftRateBasisPoints: Number(row.gift_rate_basis_points) };
    }
    return result;
  }
  async function captureOutbox(command) {
    await run('INSERT INTO sync_outbox_sale VALUES(?,?,?,?,?,?)', [storeId, command.id, command.configurationVersion ?? null, command.planId ?? null, command.items ? 1 : 0, command.payments ? 1 : 0]);
    for (const [position, row] of (command.items ?? []).entries()) await run('INSERT INTO sync_outbox_items VALUES(?,?,?,?,?,?,?)', [storeId, command.id, position, row.serviceId ?? null, row.name, row.quantity, row.unitPriceCents]);
    for (const [position, row] of (command.payments ?? []).entries()) await run('INSERT INTO sync_outbox_payments VALUES(?,?,?,?,?)', [storeId, command.id, position, row.method, row.amountCents]);
  }
  async function extendOutbox(command) {
    const row = await one('SELECT * FROM sync_outbox_sale WHERE store_id=? AND command_id=?', [storeId, command.id]); if (!row) return command;
    if (row.configuration_version !== null) command.configurationVersion = String(row.configuration_version); if (row.plan_id !== null) command.planId = row.plan_id;
    if (String(row.has_items) === '1') command.items = (await all('SELECT * FROM sync_outbox_items WHERE store_id=? AND command_id=? ORDER BY position', [storeId, command.id])).map(row => ({ ...(row.service_id === null ? {} : { serviceId: row.service_id }), name: row.name, quantity: Number(row.quantity), unitPriceCents: String(row.unit_price_cents) }));
    if (String(row.has_payments) === '1') command.payments = (await all('SELECT * FROM sync_outbox_payments WHERE store_id=? AND command_id=? ORDER BY position', [storeId, command.id])).map(row => ({ method: row.method, amountCents: String(row.amount_cents) }));
    return command;
  }
  return { configuration, saveConfiguration, write, read, captureOutbox, extendOutbox };
}
