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
const rechargeSettingsKey = 'hairstudio_recharge_settings_v1';
const { rechargeGiftCent, normalizeRechargeSettings } = await import('../src/recharge-settings.js');

function resetStorage() {
  localStorage.values.clear();
  localStorage.failKey = null;
  localStorage.failOnce = false;
}

test('invalid service IDs reject backup preview and restore before any storage writes', () => {
  resetStorage(); localDb.init();
  localDb.saveService({ name: '测试项目', price: 38 });
  localDb.createMember({ name: '账本保留', phone: '13800001111', initialBalance: 100 });
  const original = localDb.readBackupState(), stored = new Map(localStorage.values);
  for (const services of [[{ ...original.services[0], id: '' }], [{ ...original.services[0], id: '   ' }],
    [original.services[0], { ...original.services[0], name: '重复单号' }]]) {
    const backup = JSON.stringify({ data: { ...original, services } });
    assert.throws(() => localDb.previewBackup(backup), /服务项目/);
    for (const mode of ['replace', 'merge']) assert.throws(() => localDb.importBackupData(backup, { mode }), /服务项目/);
    assert.deepEqual(localStorage.values, stored);
  }
});

test('backup tags keep compatible representations and reject invalid or unbounded labels', () => {
  resetStorage(); localDb.init();
  localDb.createMember({ name: '旧会员', phone: '13800001111' });
  const original = localDb.readBackupState();
  for (const tags of ['VIP', ['常客', '年卡'], null, []]) {
    const data = structuredClone(original); data.members[0].tags = tags;
    localDb.importBackupData(JSON.stringify({ data }), { mode: 'replace' });
    assert.deepEqual(localDb.getMembers()[0].tags, tags);
  }
  const stored = new Map(localStorage.values);
  for (const tags of [{ value: 'VIP' }, 1, true, ['VIP', 1], Array(33).fill('VIP'), 'x'.repeat(129), ['x'.repeat(129)]]) {
    const data = structuredClone(original); data.members[0].tags = tags;
    assert.throws(() => localDb.importBackupData(JSON.stringify({ data }), { mode: 'replace' }), /标签/);
    assert.deepEqual(localStorage.values, stored);
  }
});

test('gift rates round to cents and reject invalid configuration', () => {
  assert.equal(rechargeGiftCent(19.99, { giftEnabled: true, giftRate: 12.5 }), 250);
  assert.equal(rechargeGiftCent(0.05, { giftEnabled: true, giftRate: 10 }), 1);
  assert.equal(rechargeGiftCent(200, { giftEnabled: false, giftRate: 10 }), 0);
  for (const giftRate of [-1, 100.01, 10.001, '', Infinity]) {
    assert.throws(() => normalizeRechargeSettings({ giftEnabled: true, giftRate }));
  }
  assert.throws(() => normalizeRechargeSettings({ giftEnabled: 'false', giftRate: 10 }));
});

test('disabled gifts reject direct writes without changing the account and channels are optional', () => {
  resetStorage(); localDb.init();
  const member = localDb.createMember({ name: '规则客户', phone: '13800005001' });
  localDb.saveRechargeSettings({ giftEnabled: false, giftRate: 12.5 });
  const before = localDb.readBackupState();
  assert.throws(() => localDb.recharge({ memberId: member.id, actualPay: 100, giftAmount: 10 }), /已关闭/);
  assert.deepEqual(localDb.readBackupState(), before);
  localDb.recharge({ memberId: member.id, actualPay: 100 });
  assert.equal(localDb.getMemberById(member.id).balance, 10000);
  assert.equal(localDb.getLedgers()[0].remark, '充值¥100.00');
  localDb.recharge({ memberId: member.id, actualPay: 1, payMethod: '现金' });
  assert.match(localDb.getLedgers()[0].remark, /\[现金\]/);
});

test('gift settings survive backup snapshots and merges while legacy replacement restores defaults', () => {
  resetStorage(); localDb.init();
  const legacy = localDb.exportBackupData({ archiveSnapshot: false });
  assert.equal(Object.hasOwn(JSON.parse(legacy).data, 'rechargeSettings'), false);
  const policy = { giftEnabled: false, giftRate: 12.5 };
  localDb.saveRechargeSettings(policy);
  const backup = localDb.exportBackupData();
  assert.deepEqual(JSON.parse(backup).data.rechargeSettings, policy);
  assert.deepEqual(JSON.parse(localDb.getLocalSnapshots()[0].content).data.rechargeSettings, policy);
  localDb.importBackupData(legacy, { mode: 'merge' });
  assert.deepEqual(localDb.getRechargeSettings(), policy);
  localDb.importBackupData(legacy, { mode: 'replace' });
  assert.deepEqual(localDb.getRechargeSettings(), { giftEnabled: true, giftRate: 10 });
  assert.equal(Object.hasOwn(localDb.readBackupState(), 'rechargeSettings'), false);
  localDb.importBackupData(backup, { mode: 'replace' });
  assert.deepEqual(localDb.getRechargeSettings(), policy);
  localDb.applyCloudSnapshot(JSON.parse(legacy).data, 'qa-metadata', {});
  assert.deepEqual(localDb.getRechargeSettings(), { giftEnabled: true, giftRate: 10 });
  localDb.applyCloudSnapshot(JSON.parse(backup).data, 'qa-metadata', {});
  assert.deepEqual(localDb.getRechargeSettings(), policy);
});

test('gift settings save rolls back on quota failure and corrupt settings can be recovered', () => {
  resetStorage(); localDb.init();
  const policy = { giftEnabled: false, giftRate: 25 };
  localDb.saveRechargeSettings(policy);
  const backup = localDb.exportBackupData({ archiveSnapshot: false });
  localStorage.failKey = rechargeSettingsKey; localStorage.failOnce = true;
  assert.throws(() => localDb.saveRechargeSettings({ giftEnabled: true, giftRate: 20 }));
  assert.deepEqual(localDb.getRechargeSettings(), policy);
  localStorage.setItem(rechargeSettingsKey, '{broken');
  const recovery = localDb.readRecoveryState();
  assert.equal(recovery.storage[rechargeSettingsKey], '{broken');
  localDb.importBackupData(backup, { mode: 'replace' });
  assert.deepEqual(localDb.getRechargeSettings(), policy);
});

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
  localStorage.setItem(membersKey, JSON.stringify([{ ...first, balance: 37500, total_consume: 12500 }, untouched]));
  localStorage.setItem(ledgersKey, JSON.stringify([
    {
      id: 'SEED-1', memberId: first.id, type: 'RECHARGE', changeAmount: 50000,
      balanceBefore: 0, balanceAfter: 50000, remark: '开卡充值 实充¥400 送¥100 [微信支付]', created_at: timestamp
    },
    {
      id: 'SEED-2', memberId: first.id, type: 'CONSUME', changeAmount: -12000,
      balanceBefore: 50000, balanceAfter: 38000, remark: '时尚冷烫/卷发 (做大卷造型)', created_at: timestamp
    },
    {
      id: 'REAL-1', memberId: first.id, type: 'CONSUME', changeAmount: -500,
      balanceBefore: 38000, balanceAfter: 37500, remark: '真实消费', created_at: usedTimestamp
    }
  ].reverse()));

  localDb.init();
  assert.deepEqual(localDb.getMembers().map(member => member.id), [first.id]);
  assert.deepEqual(localDb.getLedgers().map(ledger => ledger.id), ['REAL-1', 'SEED-2', 'SEED-1']);

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

test('previewBackup accurately counts new and duplicated records and detects newer local transactions', () => {
  resetStorage();
  localDb.init();
  const existingMember = localDb.createMember({ name: '老会员', phone: '13811112222', initialBalance: 100 });
  const tx = localDb.getLedgers()[0];

  const backupData = {
    exportedAt: new Date(Date.now() - 3600000).toISOString(),
    appName: '梦飞空间会员管家',
    data: {
      members: [
        { id: existingMember.id, name: '老会员', phone: '13811112222', balance: 10000, total_recharge: 10000, total_consume: 0, notes: '', created_at: existingMember.created_at, updated_at: existingMember.updated_at },
        { id: 'M-NEW', name: '新会员', phone: '13999998888', balance: 5000, total_recharge: 5000, total_consume: 0, notes: '喜欢短发', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
      ],
      ledgers: [
        { id: tx.id, memberId: existingMember.id, type: 'RECHARGE', changeAmount: 10000, balanceBefore: 0, balanceAfter: 10000, created_at: tx.created_at, remark: '充值' },
        { id: 'TX-BACKUP-ONLY', memberId: 'M-NEW', type: 'RECHARGE', changeAmount: 5000, balanceBefore: 0, balanceAfter: 5000, created_at: new Date(Date.now() - 1800000).toISOString(), remark: '备份独有流水' }
      ],
      services: [],
      rechargePlans: []
    }
  };

  const preview = localDb.previewBackup(JSON.stringify(backupData));
  assert.equal(preview.isValid, true);
  assert.equal(preview.diff.newMembersCount, 1);
  assert.equal(preview.diff.existingMembersCount, 1);
  assert.equal(preview.diff.duplicateLedgersCount, 1);
  assert.equal(preview.diff.newLedgersCount, 1);
});

test('merge mode never overwrites newer member balance and never duplicates ledgers', () => {
  resetStorage();
  localDb.init();
  // 1. 创建现有会员并发生消费，当前最新余额为 6200 分 (62元)
  const member = localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  localDb.consume({ memberId: member.id, amount: 38, itemsSummary: '精致洗剪吹' });
  const currentMember = localDb.getMemberById(member.id);
  assert.equal(currentMember.balance, 6200);
  const currentLedgerCount = localDb.getLedgers().length; // 2 条流水 (开卡充值100 + 消费38)

  // 2. 模拟一个较早之前的备份，此时张姐卡内余额还是 10000 分 (100元)，且备份中还有一个新熟客李大哥
  const olderBackup = {
    exportedAt: new Date(Date.now() - 7200000).toISOString(),
    appName: '梦飞空间会员管家',
    data: {
      members: [
        { id: member.id, name: '张姐', phone: '13800001111', balance: 10000, total_recharge: 10000, total_consume: 0, notes: '偏好温水', created_at: member.created_at, updated_at: member.created_at },
        { id: 'M-LI', name: '李大哥', phone: '13922223333', balance: 20000, total_recharge: 20000, total_consume: 0, notes: '平头', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
      ],
      ledgers: [
        // 备份中包含张姐最初的开卡充值单号 (已存在于当前)
        localDb.getLedgers().find(l => l.type === 'RECHARGE'),
        // 以及一条李大哥在备份时的开卡流水
        { id: 'TX-LI-INIT', memberId: 'M-LI', type: 'RECHARGE', changeAmount: 20000, balanceBefore: 0, balanceAfter: 20000, created_at: new Date(Date.now() - 7200000).toISOString(), remark: '李大哥开卡' }
      ],
      services: [],
      rechargePlans: []
    }
  };

  // 3. 执行智能增量合并导入
  const result = localDb.importBackupData(JSON.stringify(olderBackup), { mode: 'merge' });
  assert.equal(result.success, true);
  assert.equal(result.mode, 'merge');
  assert.equal(result.newMembersAdded, 1);
  assert.equal(result.newLedgersAdded, 1);

  // 4. 验证核心数据安全：张姐的卡内最新余额 6200 (62元) 绝未被旧备份的 10000 (100元) 覆盖！
  const verifyZhang = localDb.getMemberById(member.id);
  assert.equal(verifyZhang.balance, 6200);
  assert.equal(verifyZhang.notes, '偏好温水'); // 补充了偏好备注

  // 5. 验证新会员李大哥成功并入
  const li = localDb.getMembers('李大哥')[0];
  assert.ok(li);
  assert.equal(li.phone, '13922223333');
  assert.equal(li.balance, 20000);

  // 6. 验证流水去重：已有的充值流水不重复，总流水刚好增加了李大哥的一条流水
  assert.equal(localDb.getLedgers().length, currentLedgerCount + 1);
  assert.equal(localDb.getLedgers().filter(l => l.id === olderBackup.data.ledgers[0].id).length, 1);
});

test('exporting backup records snapshot in local snapshot archive', () => {
  resetStorage();
  localDb.init();
  localDb.createMember({ name: '测试会员', phone: '13888889999', initialBalance: 50 });

  assert.equal(localDb.getLocalSnapshots().length, 0);
  localDb.exportBackupData();
  const snapshots = localDb.getLocalSnapshots();
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].memberCount, 1);
  assert.ok(snapshots[0].fileName.includes('会员账本备份'));
});
