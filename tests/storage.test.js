import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  values = new Map();
  failKey = null;
  failOnce = false;

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    if (key === this.failKey && this.failOnce) {
      this.failOnce = false;
      throw new Error('quota exceeded');
    }
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

globalThis.localStorage = new MemoryStorage();
const { localDb } = await import('../src/storage.js');
const membersKey = 'hairstudio_members_v2';
const ledgersKey = 'hairstudio_ledgers_v2';
const servicesKey = 'hairstudio_services_v2';
const plansKey = 'hairstudio_plans_v2';

function resetStorage() {
  localStorage.values.clear();
  localStorage.failKey = null;
  localStorage.failOnce = false;
}

test('first initialization creates an empty ledger, not demo customers', () => {
  resetStorage();
  localDb.init();
  assert.deepEqual(localDb.getMembers(), []);
  assert.deepEqual(localDb.getLedgers(), []);
});

test('member search matches names and formatted phone numbers', () => {
  resetStorage();
  localDb.init();
  const member = localDb.createMember({ name: '梦飞熟客', phone: '13812345678' });

  assert.deepEqual(localDb.getMembers('熟客').map(item => item.id), [member.id]);
  assert.deepEqual(localDb.getMembers('138 1234 5678').map(item => item.id), [member.id]);
  assert.deepEqual(localDb.getMembers('5678').map(item => item.id), [member.id]);
});

test('initialization removes untouched legacy demo records but preserves used demo accounts', () => {
  resetStorage();
  const timestamp = new Date().toISOString();
  const usedTimestamp = new Date(Date.now() + 60000).toISOString();
  const first = {
    id: 'DEMO-1', name: '陈女士(熟客)', phone: '13812345678', balance: 38000,
    total_recharge: 50000, total_consume: 12000,
    notes: '染发喜欢板栗色，偏好温水洗头', created_at: timestamp, updated_at: usedTimestamp
  };
  const untouched = {
    id: 'DEMO-2', name: '刘大哥', phone: '13988886666', balance: 16200,
    total_recharge: 20000, total_consume: 3800,
    notes: '每个月固定剪寸头', created_at: timestamp, updated_at: timestamp
  };
  localStorage.setItem(membersKey, JSON.stringify([first, untouched]));
  localStorage.setItem(ledgersKey, JSON.stringify([
    {
      id: 'SEED-1', memberId: first.id, type: 'RECHARGE', changeAmount: 50000,
      balanceBefore: 0, balanceAfter: 50000, remark: '开卡充值 实充¥400 送¥100 [微信支付]'
    },
    {
      id: 'SEED-2', memberId: first.id, type: 'CONSUME', changeAmount: -12000,
      balanceBefore: 50000, balanceAfter: 38000, remark: '时尚冷烫/卷发 (做大卷造型)'
    },
    {
      id: 'REAL-1', memberId: first.id, type: 'CONSUME', changeAmount: -500,
      balanceBefore: 38000, balanceAfter: 37500, remark: '真实消费'
    }
  ]));

  localDb.init();
  assert.deepEqual(localDb.getMembers().map(member => member.id), [first.id]);
  assert.deepEqual(localDb.getLedgers().map(ledger => ledger.id), ['SEED-1', 'SEED-2', 'REAL-1']);

  resetStorage();
  const untouchedFirst = { ...first, updated_at: timestamp };
  localStorage.setItem(membersKey, JSON.stringify([untouchedFirst, untouched]));
  localStorage.setItem(ledgersKey, JSON.stringify([
    {
      id: 'SEED-1', memberId: first.id, type: 'RECHARGE', changeAmount: 50000,
      balanceBefore: 0, balanceAfter: 50000, remark: '开卡充值 实充¥400 送¥100 [微信支付]'
    },
    {
      id: 'SEED-2', memberId: first.id, type: 'CONSUME', changeAmount: -12000,
      balanceBefore: 50000, balanceAfter: 38000, remark: '时尚冷烫/卷发 (做大卷造型)'
    }
  ]));
  localDb.init();
  assert.deepEqual(localDb.getMembers(), []);
  assert.deepEqual(localDb.getLedgers(), []);
});

test('recharge rejects negative components and persists both balance and ledger', () => {
  resetStorage();
  localDb.init();
  const member = localDb.createMember({ name: '测试会员', phone: '13800000000' });

  assert.throws(() => localDb.recharge({ memberId: member.id, actualPay: -100, giftAmount: 200 }));
  const result = localDb.recharge({ memberId: member.id, actualPay: 100, giftAmount: 20 });
  assert.equal(localDb.getMemberById(member.id).balance, 12000);
  assert.equal(localDb.getLedgers({ memberId: member.id })[0].changeAmount, 12000);
  assert.equal(result.totalCredit, 12000);
});

test('new transactions never truncate older ledger history', () => {
  resetStorage();
  localDb.init();
  const member = localDb.createMember({ name: '历史会员', phone: '13800000000' });
  const previousLedgers = Array.from({ length: 3001 }, (_, index) => ({ id: `OLD-${index}` }));
  localStorage.setItem(ledgersKey, JSON.stringify(previousLedgers));

  localDb.recordLedger({
    memberId: member.id, type: 'CONSUME', changeAmount: -100,
    balanceBefore: 1000, balanceAfter: 900, remark: '新流水'
  });
  assert.equal(localDb.getLedgers().length, 3002);
  assert.equal(localDb.getLedgers().at(-1).id, 'OLD-3000');
});

test('failed ledger write rolls back the member balance', () => {
  resetStorage();
  localDb.init();
  const member = localDb.createMember({ name: '测试会员', phone: '13800000000' });
  const priorMemberData = localStorage.getItem(membersKey);
  const priorLedgers = localStorage.getItem(ledgersKey);
  localStorage.failKey = ledgersKey;
  localStorage.failOnce = true;
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.throws(() => localDb.recharge({ memberId: member.id, actualPay: 100, giftAmount: 0 }));
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(localStorage.getItem(membersKey), priorMemberData);
  assert.equal(localStorage.getItem(ledgersKey), priorLedgers);
});

test('startup rolls back an interrupted multi-key write from its journal', () => {
  resetStorage();
  localDb.init();
  const oldMembers = JSON.stringify([]);
  const oldLedgers = JSON.stringify([]);
  localStorage.setItem(membersKey, JSON.stringify([{ id: 'PARTIAL', name: '半写入' }]));
  localStorage.setItem('hairstudio_pending_write_v1', JSON.stringify({
    version: 1,
    writes: [
      { key: membersKey, previous: oldMembers },
      { key: ledgersKey, previous: oldLedgers }
    ]
  }));

  localDb.init();
  assert.deepEqual(localDb.getMembers(), []);
  assert.equal(localStorage.getItem('hairstudio_pending_write_v1'), null);
});

test('corrupt local data is reported and never replaced with an empty ledger', () => {
  resetStorage();
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    for (const corruptData of ['{broken-json', '']) {
      localStorage.setItem(membersKey, corruptData);
      assert.throws(() => localDb.getMembers(), /本地账本数据异常/);
      assert.equal(localStorage.getItem(membersKey), corruptData);
    }
  } finally {
    console.error = originalConsoleError;
  }
});

test('invalid backup leaves existing data unchanged and valid backup restores plans', () => {
  resetStorage();
  localDb.init();
  const member = localDb.createMember({ name: '保留会员', phone: '13800000000' });
  const before = localStorage.getItem(membersKey);

  assert.throws(() => localDb.importBackupData(JSON.stringify({ data: { members: [{ id: 'bad' }] } })));
  assert.equal(localStorage.getItem(membersKey), before);

  const backup = {
    data: {
      members: [{ ...member, id: 'M-RESTORED', name: '恢复会员' }],
      ledgers: [],
      services: [],
      rechargePlans: [{ pay: 88, gift: 12 }]
    }
  };
  localDb.importBackupData(JSON.stringify(backup));
  assert.equal(localDb.getMembers()[0].name, '恢复会员');
  assert.deepEqual(localDb.getRechargePlans(), [{ pay: 88, gift: 12 }]);
  assert.deepEqual(JSON.parse(localStorage.getItem(servicesKey)), []);
  assert.deepEqual(JSON.parse(localStorage.getItem(plansKey)), [{ pay: 88, gift: 12 }]);
});
