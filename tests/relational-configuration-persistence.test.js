import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openNodeSqlite } from '../tools/sqlite-node-driver.mjs';
import { createRelationalSqlite } from '../src/relational-sqlite.js';
import { LICENSE_FEATURES } from '../src/license-policy.js';
import { prepareSale, configurationInput } from '../src/relational-sales.js';
import { createRecharge, applyFinancialCommand } from '../src/ledger-domain.js';
import { yuanCents, displayCents } from '../src/relational-presentation.js';

const ledgerEpoch = '00000000-0000-4000-8000-000000000001';
const storeId = 'store-config-test', deviceId = 'device-config-test';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'member-config-'));
  const path = join(directory, 'ledger.sqlite');
  let db, driver;
  async function open() {
    driver = openNodeSqlite(path);
    db = createRelationalSqlite({
      driver,
      storeId,
      mode: 'standalone',
      ledgerEpoch: !db ? ledgerEpoch : undefined,
      now: () => '2026-11-24T12:00:00.000Z',
      authorize: async () => ({ storeId, id: 'owner-1', deviceId, role: 'owner', features: LICENSE_FEATURES })
    });
    return db.init();
  }
  await open();
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get db() { return db; },
    get driver() { return driver; },
    async reopen() {
      await db.close();
      return open();
    }
  };
}

test('service prices and gift configuration persist to SQLite database and handle disable/enable cleanly', async t => {
  const f = await fixture(t);

  // 1. Initial config with gift enabled, plans with gift, and custom services
  const initialConfigTask = {
    id: randomUUID(),
    ledgerEpoch,
    storeId,
    type: 'configuration.update',
    data: {
      expectedVersion: '0',
      rechargeSettings: { giftEnabled: true, giftRateBasisPoints: 1000 },
      services: [
        { id: 'cut', name: '总监剪发', priceCents: yuanCents('38.00') },
        { id: 'dye', name: '植物染发', priceCents: yuanCents('280.00') }
      ],
      rechargePlans: [
        { id: 'plan-1', payCents: yuanCents('100.00', { positive: true }), giftCents: yuanCents('20.00') },
        { id: 'plan-2', payCents: yuanCents('500.00', { positive: true }), giftCents: yuanCents('120.00') }
      ]
    }
  };
  const config1 = await f.db.executeTask(initialConfigTask);
  assert.equal(config1.version, '1');
  assert.equal(config1.rechargeSettings.giftEnabled, true);
  assert.equal(config1.rechargeSettings.giftRateBasisPoints, 1000);
  assert.equal(config1.services.length, 2);
  assert.equal(config1.services[0].priceCents, '3800');
  assert.equal(config1.services[1].priceCents, '28000');
  assert.equal(config1.rechargePlans[0].giftCents, '2000');

  // Verify database tables directly
  const dbSettings1 = f.driver.all('SELECT * FROM store_recharge_settings WHERE store_id=?', [storeId])[0];
  assert.equal(String(dbSettings1.version), '1');
  assert.equal(String(dbSettings1.gift_enabled), '1');
  assert.equal(String(dbSettings1.gift_rate_basis_points), '1000');

  const dbServices1 = f.driver.all('SELECT * FROM service_catalog WHERE store_id=? AND active=1 ORDER BY position', [storeId]);
  assert.equal(dbServices1.length, 2);
  assert.equal(dbServices1[0].name, '总监剪发');
  assert.equal(String(dbServices1[0].price_cents), '3800');

  // 2. Simulate user in UI: modifying service prices and unchecking giftEnabled
  // When giftEnabled is false, UI sanitizes giftCents to '0' and giftRateBasisPoints to 0
  const isGift = false;
  const updatedServices = [
    { id: 'cut', name: '特级总监剪发', price: '45.00' },
    { id: 'dye', name: '植物染发', price: '298.00' },
    { id: 'wash', name: '精油洗护', price: '68.00' }
  ];
  const existingPlans = config1.rechargePlans.map(row => ({
    id: row.id,
    pay: displayCents(row.payCents),
    gift: displayCents(row.giftCents) // User still had 20.00 and 120.00 in memory
  }));

  // Build payload exactly as RelationalConfiguration.vue now does
  const disableGiftTask = {
    id: randomUUID(),
    ledgerEpoch,
    storeId,
    type: 'configuration.update',
    data: {
      expectedVersion: config1.version,
      rechargeSettings: { giftEnabled: isGift, giftRateBasisPoints: isGift ? 1000 : 0 },
      services: updatedServices.map(row => ({
        id: row.id,
        name: row.name.trim(),
        priceCents: yuanCents(row.price)
      })),
      rechargePlans: existingPlans.map(row => ({
        id: row.id,
        payCents: yuanCents(row.pay, { positive: true }),
        giftCents: isGift ? yuanCents(row.gift || '0') : '0' // Sanitized to '0'
      }))
    }
  };

  const config2 = await f.db.executeTask(disableGiftTask);
  assert.equal(config2.version, '2');
  assert.equal(config2.rechargeSettings.giftEnabled, false);
  assert.equal(config2.rechargeSettings.giftRateBasisPoints, 0);
  assert.equal(config2.services.length, 3);
  assert.equal(config2.services[0].name, '特级总监剪发');
  assert.equal(config2.services[0].priceCents, '4500');
  assert.equal(config2.services[1].priceCents, '29800');
  assert.equal(config2.services[2].name, '精油洗护');
  assert.equal(config2.services[2].priceCents, '6800');
  assert.equal(config2.rechargePlans[0].giftCents, '0');
  assert.equal(config2.rechargePlans[1].giftCents, '0');

  // Verify persistence in SQLite database directly
  const dbSettings2 = f.driver.all('SELECT * FROM store_recharge_settings WHERE store_id=?', [storeId])[0];
  assert.equal(String(dbSettings2.version), '2');
  assert.equal(String(dbSettings2.gift_enabled), '0'); // Confirmed in DB: gift_enabled is 0
  assert.equal(String(dbSettings2.gift_rate_basis_points), '0');

  const dbServices2 = f.driver.all('SELECT * FROM service_catalog WHERE store_id=? AND active=1 ORDER BY position', [storeId]);
  assert.equal(dbServices2.length, 3);
  assert.equal(String(dbServices2[0].price_cents), '4500'); // Confirmed in DB: price updated to 4500
  assert.equal(String(dbServices2[2].price_cents), '6800'); // Confirmed in DB: new service added at 6800

  const dbPlans2 = f.driver.all('SELECT * FROM recharge_plan_items WHERE store_id=? AND active=1 ORDER BY position', [storeId]);
  assert.equal(dbPlans2.length, 2);
  assert.equal(String(dbPlans2[0].gift_cents), '0'); // Confirmed in DB: gift_cents is 0
  assert.equal(String(dbPlans2[1].gift_cents), '0');

  // 3. Reopen database from disk and verify it preserves the state across restart
  await f.reopen();
  const reloaded = await f.db.getConfiguration();
  assert.equal(reloaded.version, '2');
  assert.equal(reloaded.rechargeSettings.giftEnabled, false); // Remains unchecked on reload!
  assert.equal(reloaded.services.length, 3);
  assert.equal(reloaded.services[0].priceCents, '4500');
  assert.equal(reloaded.services[2].name, '精油洗护');
  assert.equal(reloaded.rechargePlans[0].giftCents, '0');

  // 4. Test Recharge Sale behavior when giftEnabled is false
  const member = await f.db.createMember({ name: '测试客户', phone: '13800000000' }, { id: randomUUID(), ledgerEpoch, storeId });

  // In RelationalSale.vue: when togglePlan is clicked with giftEnabled=false:
  const selectedPlan = reloaded.rechargePlans[0];
  const formPlanId = selectedPlan.id;
  const formPay = displayCents(selectedPlan.payCents); // "100.00"
  const formGift = reloaded.rechargeSettings.giftEnabled ? displayCents(selectedPlan.giftCents) : '';
  assert.equal(formGift, ''); // No gift brought in!

  const draft = {
    memberId: member.id,
    type: 'recharge',
    expectedAccountVersion: member.accountVersion,
    expectedProfileVersion: member.version,
    actualPayCents: yuanCents(formPay, { positive: true }),
    giftCents: !reloaded.rechargeSettings.giftEnabled ? '0' : formGift ? yuanCents(formGift) : '0',
    configurationVersion: reloaded.version,
    planId: formPlanId,
    payMethod: '微信'
  };

  prepareSale(draft, reloaded);
  const financial = applyFinancialCommand(member.balanceCents, createRecharge(draft));

  assert.equal(draft.giftCents, '0');
  assert.equal(draft.actualPayCents, '10000');
  assert.equal(financial.balanceAfterCents, '10000'); // Exactly 100.00 credited, 0 gift!

  // Execute recharge sale and verify in DB
  const saleCommand = {
    id: randomUUID(),
    ledgerEpoch,
    storeId,
    ...draft
  };
  const result = await f.db.executeCommand(saleCommand);
  assert.equal(result.balanceAfterCents, '10000');

  const dbRechargeDetail = f.driver.all('SELECT * FROM recharge_details WHERE store_id=? AND entry_id=?', [storeId, result.entryId])[0];
  assert.equal(String(dbRechargeDetail.actual_pay_cents), '10000');
  assert.equal(String(dbRechargeDetail.gift_cents), '0');
  assert.equal(String(dbRechargeDetail.gift_enabled), '0');
});
