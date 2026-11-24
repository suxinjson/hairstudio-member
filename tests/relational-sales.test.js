import test from 'node:test';
import assert from 'node:assert/strict';
import { configurationInput, emptyConfiguration, prepareSale, saleSnapshot } from '../src/relational-sales.js';
import { validateFinancialCommand } from '../src/relational-contract.js';

const command = () => ({ id: 'command-20261119-test', storeId: 'store', ledgerEpoch: '00000000-0000-4000-8000-000000000001', memberId: 'member', type: 'consume', amountCents: '1010', expectedAccountVersion: '0' });
test('configuration is bounded, typed, unique, exact and captured independently of the caller', () => {
  const input = { expectedVersion: '0', services: [{ id: 'cut', name: '剪发', priceCents: '1010' }], rechargePlans: [], rechargeSettings: { giftEnabled: false, giftRateBasisPoints: 1000 } };
  const saved = configurationInput(input); input.services[0].priceCents = '1'; assert.equal(saved.services[0].priceCents, '1010');
  for (const change of [v => v.services.push(v.services[0]), v => v.services[0].priceCents = 1, v => v.expectedVersion = -1, v => v.rechargeSettings.giftEnabled = 0, v => v.rechargeSettings.giftRateBasisPoints = 10001, v => v.rechargePlans.push({ id: 'plan', payCents: '1', giftCents: '1' })]) {
    const invalid = structuredClone(saved); change(invalid); assert.throws(() => configurationInput(invalid));
  }
});
test('sale contracts reject identity coercion, floating prices, mismatched totals and unsupported fields', () => {
  for (const extra of [{ actorId: 123 }, { deviceId: ['test-device-20261119'] }, { items: [] }, { items: [{ name: '剪发', quantity: 1, unitPriceCents: '1000' }] }, { items: [{ name: '剪发', quantity: 1.5, unitPriceCents: '1010' }] }, { configurationVersion: '0', items: [{ serviceId: 'cut', name: '剪发', quantity: 1, unitPriceCents: '1010', unknown: true }] }]) assert.throws(() => validateFinancialCommand({ ...command(), ...extra }));
  assert.throws(() => validateFinancialCommand({ ...command(), type: 'recharge', amountCents: undefined, actualPayCents: '100', payments: [{ method: '现金', amountCents: '99' }] }));
});
test('configured service and plan prices require fresh configuration and disabled gifts are enforced', () => {
  const config = { ...emptyConfiguration(), version: '1', services: [{ id: 'cut', name: '剪发', priceCents: '1010' }], rechargePlans: [{ id: 'plan', payCents: '1000', giftCents: '100' }] };
  const sale = { ...command(), configurationVersion: '1', items: [{ serviceId: 'cut', name: '剪发', quantity: 1, unitPriceCents: '1010' }] };
  assert.equal(prepareSale(sale, config).items[0].lineTotalCents, '1010');
  assert.throws(() => prepareSale({ ...sale, configurationVersion: '0' }, config), { code: 'CONFIGURATION_VERSION_CHANGED' });
  assert.throws(() => prepareSale({ ...sale, items: [{ ...sale.items[0], name: '改名' }] }, config), { code: 'SALE_PRICE_CHANGED' });
  assert.throws(() => prepareSale({ type: 'recharge', actualPayCents: '1000', giftCents: '100' }, { ...config, rechargeSettings: { giftEnabled: false, giftRateBasisPoints: 1000 } }), { code: 'GIFT_DISABLED' });
});
test('snapshot validation uses captured rows and catches inconsistent immutable details', () => {
  const sale = prepareSale({ type: 'recharge', actualPayCents: '1010', giftCents: '101', payments: [{ method: '现金', amountCents: '1000' }, { method: '微信', amountCents: '10' }] }, emptyConfiguration());
  const entry = { type: 'recharge', actualPayCents: '1010', giftCents: '101', deltaCents: '1111', ...sale };
  assert.deepEqual(saleSnapshot(entry), sale);
  assert.throws(() => saleSnapshot({ ...entry, recharge: { ...sale.recharge, giftEnabled: false } }));
  assert.throws(() => saleSnapshot({ ...entry, payments: [{ method: '现金', amountCents: '1' }] }));
});
