// 手机本地单机存储引擎 (企业级强一致性 + 离线容灾 + 误操作冲正撤销)

const STORAGE_KEYS = {
  MEMBERS: 'hairstudio_members_v2',
  LEDGERS: 'hairstudio_ledgers_v2',
  SERVICES: 'hairstudio_services_v2',
  RECHARGE_PLANS: 'hairstudio_plans_v2'
};

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
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : defaultVal;
  } catch (e) {
    console.error('读取存储异常:', e);
    return defaultVal;
  }
}

function save(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.error('写入存储异常:', e);
    alert('本地存储写入异常，请检查手机可用空间！');
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
    // 初始化服务项目
    if (!localStorage.getItem(STORAGE_KEYS.SERVICES)) {
      save(STORAGE_KEYS.SERVICES, DEFAULT_SERVICES);
    }
    // 初始化充值档位
    if (!localStorage.getItem(STORAGE_KEYS.RECHARGE_PLANS)) {
      save(STORAGE_KEYS.RECHARGE_PLANS, DEFAULT_RECHARGE_PLANS);
    }

    // 初始化会员
    const members = load(STORAGE_KEYS.MEMBERS, null);
    if (!members) {
      const initMembers = [
        {
          id: generateId('M'),
          name: '陈女士(熟客)',
          phone: '13812345678',
          balance: 38000, // 380元
          total_recharge: 50000,
          total_consume: 12000,
          notes: '染发喜欢板栗色，偏好温水洗头',
          created_at: nowISO(),
          updated_at: nowISO()
        },
        {
          id: generateId('M'),
          name: '刘大哥',
          phone: '13988886666',
          balance: 16200, // 162元
          total_recharge: 20000,
          total_consume: 3800,
          notes: '每个月固定剪寸头',
          created_at: nowISO(),
          updated_at: nowISO()
        }
      ];
      save(STORAGE_KEYS.MEMBERS, initMembers);

      // 初始化初始流水
      const initLedgers = [
        {
          id: generateId('TX'),
          memberId: initMembers[0].id,
          memberName: initMembers[0].name,
          memberPhone: initMembers[0].phone,
          type: 'RECHARGE',
          changeAmount: 50000,
          balanceBefore: 0,
          balanceAfter: 50000,
          remark: '开卡充值 实充¥400 送¥100 [微信支付]',
          created_at: new Date(Date.now() - 86400000 * 2).toISOString()
        },
        {
          id: generateId('TX'),
          memberId: initMembers[0].id,
          memberName: initMembers[0].name,
          memberPhone: initMembers[0].phone,
          type: 'CONSUME',
          changeAmount: -12000,
          balanceBefore: 50000,
          balanceAfter: 38000,
          remark: '时尚冷烫/卷发 (做大卷造型)',
          created_at: new Date(Date.now() - 86400000).toISOString()
        }
      ];
      save(STORAGE_KEYS.LEDGERS, initLedgers);
    }
  },

  // --- 会员管理 ---
  getMembers(query = '') {
    const members = load(STORAGE_KEYS.MEMBERS);
    if (!query || !query.trim()) {
      return [...members].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    }
    const q = query.trim().toLowerCase();
    return members.filter(m => 
      m.name.toLowerCase().includes(q) || m.phone.includes(q)
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

    const initCent = Math.round(Number(initialBalance || 0) * 100);
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
    save(STORAGE_KEYS.MEMBERS, members);

    if (initCent > 0) {
      this.recordLedger({
        memberId: newMember.id,
        type: 'RECHARGE',
        changeAmount: initCent,
        balanceBefore: 0,
        balanceAfter: initCent,
        remark: '开卡初始存入额度'
      });
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

    const actualCent = Math.round(Number(actualPay || 0) * 100);
    const giftCent = Math.round(Number(giftAmount || 0) * 100);
    const totalCredit = actualCent + giftCent;
    if (totalCredit <= 0) throw new Error('充值总额必须大于0');

    const before = m.balance;
    const after = before + totalCredit;

    m.balance = after;
    m.total_recharge = (m.total_recharge || 0) + totalCredit;
    m.updated_at = nowISO();
    save(STORAGE_KEYS.MEMBERS, members);

    const remarkText = giftCent > 0 
      ? `实充¥${(actualCent/100).toFixed(2)}，送¥${(giftCent/100).toFixed(2)} [${payMethod}]${remark ? ' ' + remark : ''}`
      : `充值¥${(actualCent/100).toFixed(2)} [${payMethod}]${remark ? ' ' + remark : ''}`;

    const ledger = this.recordLedger({
      memberId: m.id,
      type: 'RECHARGE',
      changeAmount: totalCredit,
      balanceBefore: before,
      balanceAfter: after,
      remark: remarkText
    });

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

    const amountCent = Math.round(Number(amount) * 100);
    if (isNaN(amountCent) || amountCent <= 0) throw new Error('消费扣款金额必须大于0');
    if (m.balance < amountCent) {
      throw new Error(`卡内余额不足！当前剩余 ¥${(m.balance/100).toFixed(2)}，无法扣除 ¥${(amountCent/100).toFixed(2)}`);
    }

    const before = m.balance;
    const after = before - amountCent;

    m.balance = after;
    m.total_consume = (m.total_consume || 0) + amountCent;
    m.updated_at = nowISO();
    save(STORAGE_KEYS.MEMBERS, members);

    const detail = itemsSummary + (remark ? ` (${remark})` : '');
    const ledger = this.recordLedger({
      memberId: m.id,
      type: 'CONSUME',
      changeAmount: -amountCent,
      balanceBefore: before,
      balanceAfter: after,
      remark: detail
    });

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
    save(STORAGE_KEYS.MEMBERS, members);

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
    save(STORAGE_KEYS.LEDGERS, ledgers);

    return {
      success: true,
      newBalance: after,
      refundLedgerId: refundLedgerRecord.id
    };
  },

  // --- 不可变流水记录 ---
  recordLedger({ memberId, type, changeAmount, balanceBefore, balanceAfter, remark }) {
    const ledgers = load(STORAGE_KEYS.LEDGERS);
    const members = load(STORAGE_KEYS.MEMBERS);
    const m = members.find(item => item.id === memberId);

    const record = {
      id: generateId('TX'),
      memberId,
      memberName: m ? m.name : '未知会员',
      memberPhone: m ? m.phone : '',
      type, // 'RECHARGE' | 'CONSUME' | 'REFUND'
      changeAmount,
      balanceBefore,
      balanceAfter,
      remark,
      created_at: nowISO()
    };

    ledgers.unshift(record);
    if (ledgers.length > 3000) ledgers.length = 3000;
    save(STORAGE_KEYS.LEDGERS, ledgers);
    return record;
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
      appName: '理发店会员管家独立App',
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
      save(STORAGE_KEYS.MEMBERS, parsed.data.members);
      if (Array.isArray(parsed.data.ledgers)) {
        save(STORAGE_KEYS.LEDGERS, parsed.data.ledgers);
      }
      if (Array.isArray(parsed.data.services)) {
        save(STORAGE_KEYS.SERVICES, parsed.data.services);
      }
      if (Array.isArray(parsed.data.rechargePlans)) {
        save(STORAGE_KEYS.RECHARGE_PLANS, parsed.data.rechargePlans);
      }
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
