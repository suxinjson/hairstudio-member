import { ApiError } from './security.js';
import { requireFeature } from './entitlements.js';
import { configurationInput, emptyConfiguration } from '../src/relational-sales.js';
import { requireLedgerEpoch } from '../src/ledger-epoch.js';

export async function readConfiguration(client, storeId, { lock = false } = {}) {
  const { rows: [settings] } = await client.query('SELECT * FROM store_recharge_settings WHERE store_id=$1' + (lock ? ' FOR SHARE' : ''), [storeId]);
  if (lock && !settings) throw new ApiError(409, '账本配置记录缺失，请核对初始化状态', 'CONFIGURATION_REQUIRED');
  if (!settings) return emptyConfiguration();
  const { rows: services } = await client.query('SELECT id,name,price_cents FROM service_catalog WHERE store_id=$1 AND active=true ORDER BY position,id', [storeId]);
  const { rows: plans } = await client.query('SELECT id,pay_cents,gift_cents FROM recharge_plan_items WHERE store_id=$1 AND active=true ORDER BY position,id', [storeId]);
  return { version: String(settings.version), services: services.map(row => ({ id: row.id, name: row.name, priceCents: String(row.price_cents) })),
    rechargePlans: plans.map(row => ({ id: row.id, payCents: String(row.pay_cents), giftCents: String(row.gift_cents) })),
    rechargeSettings: { giftEnabled: settings.gift_enabled, giftRateBasisPoints: settings.gift_rate_basis_points } };
}

export function createConfigurationService({ withAuthorized, withTask, audit, recordChange }) {
  return {
    getConfiguration(identity, { ledgerEpoch } = {}) {
      return withAuthorized(identity, 'read', (client, user) => {
        if (ledgerEpoch !== undefined) requireLedgerEpoch(ledgerEpoch, user.ledger_epoch);
        return readConfiguration(client, user.store_id);
      }, { consistentRead: true });
    },
    async updateConfiguration(identity, input, task) {
      let data; try { data = configurationInput(input); } catch (error) { if (!error.status) error.status = 400; throw error; }
      return withTask(identity, 'owner', 'settings', 'configuration.update', input, task, undefined, async (client, user) => {
        requireFeature(user.entitlements, 'settings');
        await client.query('INSERT INTO store_recharge_settings(store_id) VALUES($1) ON CONFLICT(store_id) DO NOTHING', [user.store_id]);
        const { rows: [settings] } = await client.query('SELECT version FROM store_recharge_settings WHERE store_id=$1 FOR UPDATE', [user.store_id]);
        if (String(settings.version) !== data.expectedVersion) throw new ApiError(409, '配置已变化，请重新加载后核对', 'CONFIGURATION_VERSION_CHANGED');
        await client.query('UPDATE store_recharge_settings SET gift_enabled=$1,gift_rate_basis_points=$2,version=version+1,updated_at=now() WHERE store_id=$3', [data.rechargeSettings.giftEnabled, data.rechargeSettings.giftRateBasisPoints, user.store_id]);
        await client.query('UPDATE service_catalog SET active=false WHERE store_id=$1', [user.store_id]);
        await client.query('UPDATE recharge_plan_items SET active=false WHERE store_id=$1', [user.store_id]);
        for (const [position, row] of data.services.entries()) await client.query(`INSERT INTO service_catalog(store_id,id,name,price_cents,position,version) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(store_id,id) DO UPDATE SET name=EXCLUDED.name,price_cents=EXCLUDED.price_cents,position=EXCLUDED.position,version=EXCLUDED.version,active=true`, [user.store_id, row.id, row.name, row.priceCents, position, String(BigInt(data.expectedVersion) + 1n)]);
        for (const [position, row] of data.rechargePlans.entries()) await client.query(`INSERT INTO recharge_plan_items(store_id,id,pay_cents,gift_cents,position) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(store_id,id) DO UPDATE SET pay_cents=EXCLUDED.pay_cents,gift_cents=EXCLUDED.gift_cents,position=EXCLUDED.position,active=true`, [user.store_id, row.id, row.payCents, row.giftCents, position]);
        await recordChange(client, user.store_id, 'configuration', 'store');
        await audit(client, user, 'configuration_updated', { version: String(BigInt(data.expectedVersion) + 1n), serviceCount: data.services.length, planCount: data.rechargePlans.length });
        return readConfiguration(client, user.store_id);
      });
    }
  };
}

export async function writeSale(client, storeId, entryId, sale) {
  for (const [position, row] of sale.items.entries()) await client.query('INSERT INTO consumption_items(store_id,entry_id,position,service_id,name,quantity,unit_price_cents,line_total_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [storeId, entryId, position, row.serviceId, row.name, row.quantity, row.unitPriceCents, row.lineTotalCents]);
  for (const [position, row] of sale.payments.entries()) await client.query('INSERT INTO payment_records(store_id,entry_id,position,method,amount_cents) VALUES($1,$2,$3,$4,$5)', [storeId, entryId, position, row.method, row.amountCents]);
  if (sale.recharge) { const row = sale.recharge; await client.query('INSERT INTO recharge_details(store_id,entry_id,configuration_version,plan_id,actual_pay_cents,gift_cents,gift_enabled,gift_rate_basis_points) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [storeId, entryId, row.configurationVersion, row.planId, row.actualPayCents, row.giftCents, row.giftEnabled, row.giftRateBasisPoints]); }
}
export async function readSales(client, storeId, ids) {
  const map = new Map(ids.map(id => [id, { items: [], payments: [], recharge: null }])); if (!ids.length) return map;
  const { rows: items } = await client.query('SELECT * FROM consumption_items WHERE store_id=$1 AND entry_id=ANY($2::text[]) ORDER BY entry_id,position', [storeId, ids]);
  const { rows: payments } = await client.query('SELECT * FROM payment_records WHERE store_id=$1 AND entry_id=ANY($2::text[]) ORDER BY entry_id,position', [storeId, ids]);
  const { rows: recharges } = await client.query('SELECT * FROM recharge_details WHERE store_id=$1 AND entry_id=ANY($2::text[])', [storeId, ids]);
  for (const row of items) map.get(row.entry_id).items.push({ serviceId: row.service_id, name: row.name, quantity: row.quantity, unitPriceCents: String(row.unit_price_cents), lineTotalCents: String(row.line_total_cents) });
  for (const row of payments) map.get(row.entry_id).payments.push({ method: row.method, amountCents: String(row.amount_cents) });
  for (const row of recharges) map.get(row.entry_id).recharge = { configurationVersion: String(row.configuration_version), planId: row.plan_id, actualPayCents: String(row.actual_pay_cents), giftCents: String(row.gift_cents), giftEnabled: row.gift_enabled, giftRateBasisPoints: row.gift_rate_basis_points };
  return map;
}
