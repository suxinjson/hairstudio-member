// 手机本地单机存储引擎 (企业级强一致性 + 离线容灾 + 误操作冲正撤销)

const STORAGE_KEYS = {
  MEMBERS: 'hairstudio_members_v2',
  LEDGERS: 'hairstudio_ledgers_v2',
  SERVICES: 'hairstudio_services_v2',
  RECHARGE_PLANS: 'hairstudio_plans_v2'
};
const PENDING_WRITE_KEY = 'hairstudio_pending_write_v1';

// 默认理发店常用服务项目
export const DEFAULT_SERVICES = [
  { id: 's1', name: '精致洗剪吹', price: 38 },
  { id: 's2', name: '快剪/寸头', price: 25 },
  { id: 's3', name: '单人洗吹造型', price: 20 },
  { id: 's4', name: '儿童理发', price: 25 },
  { id: 's5', name: '时尚冷烫/卷发', price: 128 },
  { id: 's6', name: '植物护发染发', price: 158 },
  { id: 's7', name: '深层头皮/毛囊护理', price: 88 }
];

// 默认充值套餐
export const DEFAULT_RECHARGE_PLANS = [
  { pay: 200, gift: 20 },
  { pay: 300, gift: 40 },
  { pay: 500, gift: 80 },
  { pay: 1000, gift: 200 },
  { pay: 2000, gift: 500 }
];

function load(key, defaultVal = []) {
  const raw = localStorage.getItem(key);
  if (raw === null) return defaultVal;
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('数据结构不是数组');
    return data;
  } catch (e) {
    console.error('读取存储异常:', e);
    throw new Error(`本地账本数据异常（${key}），为避免覆盖请先恢复备份`);
  }
}

function save(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.error('写入存储异常:', e);
    throw new Error('本地存储写入失败，请检查可用空间后重试');
  }
}

function saveBatch(entries) {
  recoverPendingWrite();
  const writes = Object.entries(entries).map(([key, value]) => ({
    key,
    value: JSON.stringify(value),
    previous: localStorage.getItem(key)
  }));
  try {
    localStorage.setItem(PENDING_WRITE_KEY, JSON.stringify({ version: 1, writes }));
  } catch (error) {
    console.error('事务写入异常:', error);
    throw new Error('无法建立本地恢复点，账本未修改；请导出备份并清理存储空间后重试');
  }

  try {
    for (const write of writes) localStorage.setItem(write.key, write.value);
    localStorage.removeItem(PENDING_WRITE_KEY);
  } catch (error) {
    try {
      recoverPendingWrite();
    } catch (recoveryError) {
      console.error('事务回滚待下次启动恢复:', recoveryError);
    }
    console.error('事务写入异常:', error);
    throw new Error('本地存储写入失败，账本已回滚或将在下次启动时恢复');
  }
}

function recoverPendingWrite() {
  const raw = localStorage.getItem(PENDING_WRITE_KEY);
  if (!raw) return;
  try {
    const pending = JSON.parse(raw);
    if (pending.version !== 1 || !Array.isArray(pending.writes)) throw new Error('恢复日志格式无效');
    for (const write of [...pending.writes].reverse()) {
      if (typeof write.key !== 'string' ||
          (write.previous !== null && typeof write.previous !== 'string')) {
        throw new Error('恢复日志内容无效');
      }
      if (localStorage.getItem(write.key) === write.previous) continue;
      if (write.previous === null) localStorage.removeItem(write.key);
      else localStorage.setItem(write.key, write.previous);
    }
    localStorage.removeItem(PENDING_WRITE_KEY);
  } catch (error) {
    console.error('本地事务恢复失败:', error);
    throw new Error('检测到未完成的数据恢复；请勿清除应用数据，并尽快导出账本或联系支持');
  }
}

function moneyToCent(value, label) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || Math.round(amount * 100) !== amount * 100) {
    throw new Error(`${label}必须是非负且最多两位小数的金额`);
  }
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents)) throw new Error(`${label}超出可处理范围`);
  return cents;
}

function removeUntouchedDemoData() {
  const members = load(STORAGE_KEYS.MEMBERS);
  const ledgers = load(STORAGE_KEYS.LEDGERS);
  const demoMembers = [
    {
      name: '陈女士(熟客)', phone: '13812345678', balance: 38000,
      total_recharge: 50000, total_consume: 12000,
      notes: '染发喜欢板栗色，偏好温水洗头', ledgerCount: 2
    },
    {
      name: '刘大哥', phone: '13988886666', balance: 16200,
      total_recharge: 20000, total_consume: 3800,
      notes: '每个月固定剪寸头', ledgerCount: 0
    }
  ];
  let membersChanged = false;
  let ledgersChanged = false;

  for (const demo of demoMembers) {
    const member = members.find(item => item.name === demo.name && item.phone === demo.phone &&
      item.balance === demo.balance && item.total_recharge === demo.total_recharge &&
      item.total_consume === demo.total_consume && item.notes === demo.notes &&
      Number.isFinite(Date.parse(item.created_at)) && Number.isFinite(Date.parse(item.updated_at)) &&
      Math.abs(Date.parse(item.created_at) - Date.parse(item.updated_at)) < 60000);
    if (!member) continue;

    const linkedLedgers = ledgers.filter(item => item.memberId === member.id);
    const validSeedLedgers = demo.name === '陈女士(熟客)' && linkedLedgers.length === 2 &&
      linkedLedgers.some(item => item.type === 'RECHARGE' && item.changeAmount === 50000 &&
        item.balanceBefore === 0 && item.balanceAfter === 50000 &&
        item.remark === '开卡充值 实充¥400 送¥100 [微信支付]') &&
      linkedLedgers.some(item => item.type === 'CONSUME' && item.changeAmount === -12000 &&
        item.balanceBefore === 50000 && item.balanceAfter === 38000 &&
        item.remark === '时尚冷烫/卷发 (做大卷造型)');
    if ((demo.ledgerCount === 2 && !validSeedLedgers) ||
        (demo.ledgerCount === 0 && linkedLedgers.length !== 0)) continue;

    members.splice(members.indexOf(member), 1);
    membersChanged = true;
    if (linkedLedgers.length) {
      const linkedIds = new Set(linkedLedgers.map(item => item.id));
      for (let i = ledgers.length - 1; i >= 0; i--) {
        if (linkedIds.has(ledgers[i].id)) ledgers.splice(i, 1);
      }
      ledgersChanged = true;
    }
  }

  if (membersChanged) {
    const changes = { [STORAGE_KEYS.MEMBERS]: members };
    if (ledgersChanged) changes[STORAGE_KEYS.LEDGERS] = ledgers;
    saveBatch(changes);
  }
}

function generateId(prefix = '') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).substring(2, 6)}`.toUpperCase();
}

function nowISO() {
  return new Date().toISOString();
}

export const localDb = {
  init() {
    recoverPendingWrite();
    // 初始化服务项目
    if (localStorage.getItem(STORAGE_KEYS.SERVICES) === null) {
      save(STORAGE_KEYS.SERVICES, DEFAULT_SERVICES);
    }
    // 初始化充值档位
    if (localStorage.getItem(STORAGE_KEYS.RECHARGE_PLANS) === null) {
      save(STORAGE_KEYS.RECHARGE_PLANS, DEFAULT_RECHARGE_PLANS);
    }

    if (localStorage.getItem(STORAGE_KEYS.MEMBERS) === null) save(STORAGE_KEYS.MEMBERS, []);
    if (localStorage.getItem(STORAGE_KEYS.LEDGERS) === null) save(STORAGE_KEYS.LEDGERS, []);
    removeUntouchedDemoData();
  },

  // --- 会员管理 ---
  getMembers(query = '') {
    const members = load(STORAGE_KEYS.MEMBERS);
    if (!query || !query.trim()) {
      return [...members].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    }
    const q = query.trim().toLowerCase();
    const phoneQuery = q.replace(/\D/g, '');
    return members.filter(m => 
      m.name.toLowerCase().includes(q) || m.phone.includes(q) || (phoneQuery && m.phone.includes(phoneQuery))
    ).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  },

  getMemberById(id) {
    const members = load(STORAGE_KEYS.MEMBERS);
    return members.find(m => m.id === id) || null;
  },

  createMember({ name, phone, initialBalance = 0, notes = '' }) {
    if (!name || !name.trim()) throw new Error('会员姓名不能为空');
    if (!phone || !phone.trim()) throw new Error('手机号码不能为空');

    const cleanPhone = phone.trim();
    const members = load(STORAGE_KEYS.MEMBERS);
    if (members.some(m => m.phone === cleanPhone)) {
      throw new Error(`手机号 ${cleanPhone} 已存在`);
    }

    const initCent = moneyToCent(initialBalance || 0, '初始余额');
    const now = nowISO();
    const newMember = {
      id: generateId('M'),
      name: name.trim(),
      phone: cleanPhone,
      balance: initCent,
      total_recharge: initCent,
      total_consume: 0,
      notes: notes ? notes.trim() : '',
      created_at: now,
      updated_at: now
    };

    members.unshift(newMember);
    if (initCent > 0) {
      const ledgers = load(STORAGE_KEYS.LEDGERS);
      ledgers.unshift(this.makeLedger({
        member: newMember,
        type: 'RECHARGE',
        changeAmount: initCent,
        balanceBefore: 0,
        balanceAfter: initCent,
        remark: '开卡初始存入额度'
      }));
      saveBatch({ [STORAGE_KEYS.MEMBERS]: members, [STORAGE_KEYS.LEDGERS]: ledgers });
    } else {
      save(STORAGE_KEYS.MEMBERS, members);
    }

    return newMember;
  },

  updateMember(id, { name, phone, notes }) {
    const members = load(STORAGE_KEYS.MEMBERS);
    const m = members.find(item => item.id === id);
    if (!m) throw new Error('会员不存在');

    if (phone && phone.trim() !== m.phone) {
      const cleanPhone = phone.trim();
      if (members.some(item => item.id !== id && item.phone === cleanPhone)) {
        throw new Error(`手机号 ${cleanPhone} 已被其他会员占用`);
      }
      m.phone = cleanPhone;
    }

    if (name && name.trim()) m.name = name.trim();
    if (notes !== undefined) m.notes = notes.trim();
    m.updated_at = nowISO();

    save(STORAGE_KEYS.MEMBERS, members);
    return m;
  },

  deleteMember(id) {
    let members = load(STORAGE_KEYS.MEMBERS);
    const m = members.find(item => item.id === id);
    if (!m) throw new Error('会员不存在');
    if (m.balance > 0) {
      throw new Error(`该会员卡内尚有 ¥${(m.balance/100).toFixed(2)} 余额，请先扣除或清零后再删除`);
    }

    members = members.filter(item => item.id !== id);
    save(STORAGE_KEYS.MEMBERS, members);
    return true;
  },

  // --- 充值记账 (强事务原子性) ---
  recharge({ memberId, actualPay, giftAmount = 0, payMethod = '微信支付', remark = '' }) {
    const members = load(STORAGE_KEYS.MEMBERS);
    const m = members.find(item => item.id === memberId);
    if (!m) throw new Error('会员不存在');

    const actualCent = moneyToCent(actualPay ?? 0, '实收金额');
    const giftCent = moneyToCent(giftAmount ?? 0, '赠送金额');
    const totalCredit = actualCent + giftCent;
    if (!Number.isSafeInteger(totalCredit) || totalCredit <= 0) throw new Error('充值总额必须是有效的正数');

    const before = m.balance;
    const after = before + totalCredit;
    if (!Number.isSafeInteger(after)) throw new Error('充值后余额超出可处理范围');

    m.balance = after;
    m.total_recharge = (m.total_recharge || 0) + totalCredit;
    m.updated_at = nowISO();
    const remarkText = giftCent > 0 
      ? `实充¥${(actualCent/100).toFixed(2)}，送¥${(giftCent/100).toFixed(2)} [${payMethod}]${remark ? ' ' + remark : ''}`
      : `充值¥${(actualCent/100).toFixed(2)} [${payMethod}]${remark ? ' ' + remark : ''}`;

    const ledgers = load(STORAGE_KEYS.LEDGERS);
    const ledger = this.makeLedger({
      member: m,
      type: 'RECHARGE',
      changeAmount: totalCredit,
      balanceBefore: before,
      balanceAfter: after,
      remark: remarkText
    });
    ledgers.unshift(ledger);
    saveBatch({ [STORAGE_KEYS.MEMBERS]: members, [STORAGE_KEYS.LEDGERS]: ledgers });

    return {
      memberId: m.id,
      totalCredit,
      balanceAfter: after,
      ledgerId: ledger.id
    };
  },

  // --- 消费扣减 (防并发/超扣锁) ---
  consume({ memberId, amount, itemsSummary = '洗剪吹理发', remark = '' }) {
    const members = load(STORAGE_KEYS.MEMBERS);
    const m = members.find(item => item.id === memberId);
    if (!m) throw new Error('会员不存在');

    const amountCent = moneyToCent(amount, '消费扣款金额');
    if (amountCent <= 0) throw new Error('消费扣款金额必须大于0');
    if (m.balance < amountCent) {
      throw new Error(`卡内余额不足！当前剩余 ¥${(m.balance/100).toFixed(2)}，无法扣除 ¥${(amountCent/100).toFixed(2)}`);
    }

    const before = m.balance;
    const after = before - amountCent;
    if (!Number.isSafeInteger(after)) throw new Error('扣款后余额超出可处理范围');

    m.balance = after;
    m.total_consume = (m.total_consume || 0) + amountCent;
    m.updated_at = nowISO();
    const detail = itemsSummary + (remark ? ` (${remark})` : '');
    const ledgers = load(STORAGE_KEYS.LEDGERS);
    const ledger = this.makeLedger({
      member: m,
      type: 'CONSUME',
      changeAmount: -amountCent,
      balanceBefore: before,
      balanceAfter: after,
      remark: detail
    });
    ledgers.unshift(ledger);
    saveBatch({ [STORAGE_KEYS.MEMBERS]: members, [STORAGE_KEYS.LEDGERS]: ledgers });

    return {
      memberId: m.id,
      deductedAmount: amountCent,
      balanceAfter: after,
      ledgerId: ledger.id
    };
  },

  // --- 核心安全：错录撤回 / 红冲退款 (防止店主输错金额) ---
  refundLedger(ledgerId, reason = '店主手工撤销') {
    const ledgers = load(STORAGE_KEYS.LEDGERS);
    const target = ledgers.find(l => l.id === ledgerId);
    if (!target) throw new Error('未找到该流水记录');
    if (target.isRefunded) throw new Error('该笔记录已被撤销过，不可重复撤销');

    const members = load(STORAGE_KEYS.MEMBERS);
    const m = members.find(item => item.id === target.memberId);
    if (!m) throw new Error('关联会员不存在');

    const before = m.balance;
    let after = before;
    let refundAmount = 0;
    let refundRemark = '';

    if (target.type === 'CONSUME') {
      // 原来是消费扣款（负数），撤销需要补回会员余额
      const restoreAmount = Math.abs(target.changeAmount);
      after = before + restoreAmount;
      m.balance = after;
      m.total_consume = Math.max(0, (m.total_consume || 0) - restoreAmount);
      refundAmount = restoreAmount;
      refundRemark = `[撤销扣款冲正] 恢复¥${(restoreAmount/100).toFixed(2)} 原单号:${target.id} (${reason})`;
    } else if (target.type === 'RECHARGE') {
      // 原来是充值增加，撤销需要扣减会员余额
      const deductAmount = target.changeAmount;
      if (m.balance < deductAmount) {
        throw new Error(`会员当前余额 ¥${(m.balance/100).toFixed(2)} 低于欲撤销的充值金额 ¥${(deductAmount/100).toFixed(2)}，撤销将导致负数！`);
      }
      after = before - deductAmount;
      m.balance = after;
      m.total_recharge = Math.max(0, (m.total_recharge || 0) - deductAmount);
      refundAmount = -deductAmount;
      refundRemark = `[撤销充值冲正] 扣除¥${(deductAmount/100).toFixed(2)} 原单号:${target.id} (${reason})`;
    } else {
      throw new Error('该记录类型不支持撤销');
    }

    target.isRefunded = true;
    m.updated_at = nowISO();
    // 记录冲正流水
    const refundLedgerRecord = {
      id: generateId('TX'),
      memberId: m.id,
      memberName: m.name,
      memberPhone: m.phone,
      type: 'REFUND',
      changeAmount: refundAmount,
      balanceBefore: before,
      balanceAfter: after,
      remark: refundRemark,
      created_at: nowISO()
    };

    ledgers.unshift(refundLedgerRecord);
    saveBatch({ [STORAGE_KEYS.MEMBERS]: members, [STORAGE_KEYS.LEDGERS]: ledgers });

    return {
      success: true,
      newBalance: after,
      refundLedgerId: refundLedgerRecord.id
    };
  },

  // --- 不可变流水记录 ---
  recordLedger({ memberId, type, changeAmount, balanceBefore, balanceAfter, remark }) {
    const members = load(STORAGE_KEYS.MEMBERS);
    const m = members.find(item => item.id === memberId);
    if (!m) throw new Error('关联会员不存在');
    const record = this.makeLedger({ member: m, memberId, type, changeAmount, balanceBefore, balanceAfter, remark });
    const ledgers = load(STORAGE_KEYS.LEDGERS);
    ledgers.unshift(record);
    save(STORAGE_KEYS.LEDGERS, ledgers);
    return record;
  },

  makeLedger({ member, memberId = member.id, type, changeAmount, balanceBefore, balanceAfter, remark }) {
    return {
      id: generateId('TX'),
      memberId,
      memberName: member.name,
      memberPhone: member.phone,
      type, // 'RECHARGE' | 'CONSUME' | 'REFUND'
      changeAmount,
      balanceBefore,
      balanceAfter,
      remark,
      created_at: nowISO()
    };
  },

  getLedgers({ memberId = '', type = '' } = {}) {
    let ledgers = load(STORAGE_KEYS.LEDGERS);
    if (memberId) {
      ledgers = ledgers.filter(l => l.memberId === memberId);
    }
    if (type) {
      ledgers = ledgers.filter(l => l.type === type);
    }
    return ledgers;
  },

  // --- 店主自定义服务品项与价格 ---
  getServices() {
    return load(STORAGE_KEYS.SERVICES, DEFAULT_SERVICES);
  },

  getRechargePlans() {
    return load(STORAGE_KEYS.RECHARGE_PLANS, DEFAULT_RECHARGE_PLANS);
  },

  saveService(item) {
    const services = this.getServices();
    if (!item.name || !item.name.trim()) throw new Error('项目名称必填');
    const price = parseFloat(item.price);
    if (isNaN(price) || price < 0) throw new Error('项目价格必须大于等于0');

    if (item.id) {
      const idx = services.findIndex(s => s.id === item.id);
      if (idx !== -1) {
        services[idx] = { ...services[idx], name: item.name.trim(), price };
      }
    } else {
      services.push({
        id: generateId('S'),
        name: item.name.trim(),
        price
      });
    }
    save(STORAGE_KEYS.SERVICES, services);
    return services;
  },

  deleteService(id) {
    let services = this.getServices();
    services = services.filter(s => s.id !== id);
    save(STORAGE_KEYS.SERVICES, services);
    return services;
  },

  // --- 营业看板汇总 ---
  getDashboard() {
    const members = load(STORAGE_KEYS.MEMBERS);
    const ledgers = load(STORAGE_KEYS.LEDGERS);

    const totalBalance = members.reduce((sum, m) => sum + (m.balance || 0), 0);
    const totalRecharge = members.reduce((sum, m) => sum + (m.total_recharge || 0), 0);
    const totalConsume = members.reduce((sum, m) => sum + (m.total_consume || 0), 0);

    const todayStr = new Date().toDateString();
    let todayRechargeCredit = 0;
    let todayRechargeCount = 0;
    let todayConsumeAmount = 0;
    let todayConsumeCount = 0;

    for (const l of ledgers) {
      if (new Date(l.created_at).toDateString() === todayStr) {
        if (l.type === 'RECHARGE') {
          todayRechargeCredit += l.changeAmount;
          todayRechargeCount++;
        } else if (l.type === 'CONSUME') {
          todayConsumeAmount += Math.abs(l.changeAmount);
          todayConsumeCount++;
        }
      }
    }

    return {
      memberCount: members.length,
      totalBalance,
      historyTotalRecharge: totalRecharge,
      historyTotalConsume: totalConsume,
      today: {
        rechargeCount: todayRechargeCount,
        rechargeCreditTotal: todayRechargeCredit,
        consumeCount: todayConsumeCount,
        consumeAmount: todayConsumeAmount
      }
    };
  },

  // --- 微信/本地一键备份与恢复 ---
  exportBackupData() {
    const backup = {
      version: '2.0',
      exportedAt: nowISO(),
      appName: '梦飞空间会员管家',
      data: {
        members: load(STORAGE_KEYS.MEMBERS),
        ledgers: load(STORAGE_KEYS.LEDGERS),
        services: load(STORAGE_KEYS.SERVICES),
        rechargePlans: load(STORAGE_KEYS.RECHARGE_PLANS)
      }
    };
    return JSON.stringify(backup, null, 2);
  },

  importBackupData(jsonString) {
    try {
      const parsed = JSON.parse(jsonString);
      if (!parsed.data || !Array.isArray(parsed.data.members)) {
        throw new Error('备份文件格式不正确，缺少会员名册数据');
      }
      const { members } = parsed.data;
      const ledgers = parsed.data.ledgers ?? [];
      const services = parsed.data.services ?? DEFAULT_SERVICES;
      const rechargePlans = parsed.data.rechargePlans ?? DEFAULT_RECHARGE_PLANS;
      if (!Array.isArray(ledgers) || !Array.isArray(services) || !Array.isArray(rechargePlans)) {
        throw new Error('备份文件中的流水、服务项目或充值档位格式不正确');
      }
      const memberIds = new Set();
      for (const member of members) {
        if (!member || typeof member.id !== 'string' || !member.id || memberIds.has(member.id) ||
            typeof member.name !== 'string' || !member.name.trim() || typeof member.phone !== 'string' ||
            !Number.isSafeInteger(member.balance) || member.balance < 0 ||
            !Number.isSafeInteger(member.total_recharge) || member.total_recharge < 0 ||
            !Number.isSafeInteger(member.total_consume) || member.total_consume < 0) {
          throw new Error('备份文件包含无效或重复的会员数据');
        }
        memberIds.add(member.id);
      }
      for (const ledger of ledgers) {
        if (!ledger || typeof ledger.id !== 'string' || !memberIds.has(ledger.memberId) ||
            !['RECHARGE', 'CONSUME', 'REFUND'].includes(ledger.type) ||
            !Number.isSafeInteger(ledger.changeAmount) || !Number.isSafeInteger(ledger.balanceBefore) ||
            !Number.isSafeInteger(ledger.balanceAfter) || typeof ledger.created_at !== 'string' ||
            Number.isNaN(Date.parse(ledger.created_at))) {
          throw new Error('备份文件包含无效的流水数据');
        }
      }
      if (services.some(item => !item || typeof item.id !== 'string' || typeof item.name !== 'string' ||
          !item.name.trim() || !Number.isFinite(item.price) || item.price < 0)) {
        throw new Error('备份文件包含无效的服务项目');
      }
      if (rechargePlans.some(plan => !plan || !Number.isFinite(plan.pay) || plan.pay <= 0 ||
          !Number.isFinite(plan.gift) || plan.gift < 0)) {
        throw new Error('备份文件包含无效的充值档位');
      }
      saveBatch({
        [STORAGE_KEYS.MEMBERS]: members,
        [STORAGE_KEYS.LEDGERS]: ledgers,
        [STORAGE_KEYS.SERVICES]: services,
        [STORAGE_KEYS.RECHARGE_PLANS]: rechargePlans
      });
      return { success: true, count: parsed.data.members.length };
    } catch (e) {
      throw new Error('导入失败：' + e.message);
    }
  },

  exportCSV() {
    const ledgers = load(STORAGE_KEYS.LEDGERS);
    let csv = '\uFEFF流水单号,会员姓名,联系电话,流水类型,变动额度(元),变动后余额(元),明细备注,记录时间\n';
    for (const l of ledgers) {
      let typeText = '消费扣款';
      if (l.type === 'RECHARGE') typeText = '储值入账';
      if (l.type === 'REFUND') typeText = '撤销冲正';
      const changeYuan = (l.changeAmount / 100).toFixed(2);
      const afterYuan = (l.balanceAfter / 100).toFixed(2);
      const time = new Date(l.created_at).toLocaleString();
      csv += `"${l.id}","${l.memberName}","${l.memberPhone}","${typeText}","${changeYuan}","${afterYuan}","${l.remark}","${time}"\n`;
    }
    return csv;
  }
};
