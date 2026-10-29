// 手机本地单机存储引擎 (纯本地 Local-First 架构，零服务器依赖，离线高可靠)

const STORAGE_KEYS = {
  MEMBERS: 'hairstudio_members_v1',
  LEDGERS: 'hairstudio_ledgers_v1',
  RECHARGES: 'hairstudio_recharges_v1',
  CONSUMES: 'hairstudio_consumes_v1',
  SETTINGS: 'hairstudio_settings_v1'
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
    console.error('读取本地存储异常:', e);
    return defaultVal;
  }
}

function save(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.error('写入本地存储异常:', e);
    alert('手机本地存储已满或受到限制，请检查手机存储空间！');
  }
}

function generateId(prefix = '') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).substring(2, 6)}`.toUpperCase();
}

function nowISO() {
  return new Date().toISOString();
}

export const localDb = {
  // 初始化系统默认数据
  init() {
    const members = load(STORAGE_KEYS.MEMBERS, null);
    if (!members) {
      // 首次使用理发店体验数据
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
    }
  },

  // 获取所有会员
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

  // 新增会员
  createMember({ name, phone, initialBalance = 0, notes = '' }) {
    if (!name || !phone) throw new Error('会员姓名和手机号不能为空');
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
      notes: notes.trim(),
      created_at: now,
      updated_at: now
    };

    members.push(newMember);
    save(STORAGE_KEYS.MEMBERS, members);

    if (initCent > 0) {
      this.recordLedger({
        memberId: newMember.id,
        type: 'RECHARGE',
        changeAmount: initCent,
        balanceBefore: 0,
        balanceAfter: initCent,
        remark: '开卡初始额度'
      });
    }

    return newMember;
  },

  // 会员充值 (原子本地事务)
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

    // 记录充值明细
    const remarkText = giftCent > 0 
      ? `实充¥${(actualCent/100).toFixed(2)}，送¥${(giftCent/100).toFixed(2)} [${payMethod}]${remark ? ' ' + remark : ''}`
      : `充值¥${(actualCent/100).toFixed(2)} [${payMethod}]${remark ? ' ' + remark : ''}`;

    this.recordLedger({
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
      actualCent,
      giftCent
    };
  },

  // 会员消费扣款
  consume({ memberId, amount, itemsSummary = '洗剪吹理发', remark = '' }) {
    const members = load(STORAGE_KEYS.MEMBERS);
    const m = members.find(item => item.id === memberId);
    if (!m) throw new Error('会员不存在');

    const amountCent = Math.round(Number(amount) * 100);
    if (isNaN(amountCent) || amountCent <= 0) throw new Error('消费金额必须大于0');
    if (m.balance < amountCent) {
      throw new Error(`余额不足！当前剩余 ¥${(m.balance/100).toFixed(2)}`);
    }

    const before = m.balance;
    const after = before - amountCent;

    m.balance = after;
    m.total_consume = (m.total_consume || 0) + amountCent;
    m.updated_at = nowISO();
    save(STORAGE_KEYS.MEMBERS, members);

    // 记录消费流水
    const detail = itemsSummary + (remark ? ` (${remark})` : '');
    this.recordLedger({
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
      balanceAfter: after
    };
  },

  // 写入流水
  recordLedger({ memberId, type, changeAmount, balanceBefore, balanceAfter, remark }) {
    const ledgers = load(STORAGE_KEYS.LEDGERS);
    const members = load(STORAGE_KEYS.MEMBERS);
    const m = members.find(item => item.id === memberId);

    const record = {
      id: generateId('TX'),
      memberId,
      memberName: m ? m.name : '未知会员',
      memberPhone: m ? m.phone : '',
      type, // 'RECHARGE' | 'CONSUME'
      changeAmount,
      balanceBefore,
      balanceAfter,
      remark,
      created_at: nowISO()
    };

    ledgers.unshift(record); // 最新记录放前面
    // 限制本地保留最新 2000 条流水，保障低端老旧手机流畅
    if (ledgers.length > 2000) ledgers.length = 2000;
    save(STORAGE_KEYS.LEDGERS, ledgers);
    return record;
  },

  // 获取流水列表
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

  // 营业看板汇总
  getDashboard() {
    const members = load(STORAGE_KEYS.MEMBERS);
    const ledgers = load(STORAGE_KEYS.LEDGERS);

    const totalBalance = members.reduce((sum, m) => sum + (m.balance || 0), 0);
    const totalRecharge = members.reduce((sum, m) => sum + (m.total_recharge || 0), 0);
    const totalConsume = members.reduce((sum, m) => sum + (m.total_consume || 0), 0);

    // 今日统计
    const todayStr = new Date().toDateString();
    let todayRechargeActual = 0;
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

  // --- 微信/手机一键备份导出与恢复 ---
  exportBackupData() {
    const backup = {
      version: '1.0',
      exportedAt: nowISO(),
      appName: '理发店会员管家单机版',
      data: {
        members: load(STORAGE_KEYS.MEMBERS),
        ledgers: load(STORAGE_KEYS.LEDGERS)
      }
    };
    return JSON.stringify(backup, null, 2);
  },

  importBackupData(jsonString) {
    try {
      const parsed = JSON.parse(jsonString);
      if (!parsed.data || !Array.isArray(parsed.data.members)) {
        throw new Error('备份文件格式不正确，缺少会员数据');
      }
      save(STORAGE_KEYS.MEMBERS, parsed.data.members);
      if (Array.isArray(parsed.data.ledgers)) {
        save(STORAGE_KEYS.LEDGERS, parsed.data.ledgers);
      }
      return { success: true, count: parsed.data.members.length };
    } catch (e) {
      throw new Error('导入失败：' + e.message);
    }
  },

  // 导出 CSV 格式 Excel 对账单
  exportCSV() {
    const ledgers = load(STORAGE_KEYS.LEDGERS);
    let csv = '\uFEFF流水号,会员姓名,手机号,交易类型,变动金额(元),变动后余额(元),交易备注,交易时间\n';
    for (const l of ledgers) {
      const typeText = l.type === 'RECHARGE' ? '充值入账' : '消费扣减';
      const changeYuan = (l.changeAmount / 100).toFixed(2);
      const afterYuan = (l.balanceAfter / 100).toFixed(2);
      const time = new Date(l.created_at).toLocaleString();
      csv += `"${l.id}","${l.memberName}","${l.memberPhone}","${typeText}","${changeYuan}","${afterYuan}","${l.remark}","${time}"\n`;
    }
    return csv;
  }
};
