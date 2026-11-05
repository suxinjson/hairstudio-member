// 手机本地单机存储引擎 (企业级强一致性 + 离线容灾 + 误操作冲正撤销)
import { moneyToCent } from './money.js';
import { normalizeRechargeSettings } from './recharge-settings.js';
import { DATA_LIMITS, byteLength, assertJsonBudget, assertAccountLimits, validateMutationArgs, DataLimitError } from './data-limits.js';
import { mergeAccounts, normalizeRefunds, restoreArchivedMembers, validateAccountHistory, validateActiveMemberPhones, normalizeMemberPhone } from './accounting.js';
import { assertLedgerAccess } from './ledger-access.js';

export const STORAGE_KEYS = {
  MEMBERS: 'hairstudio_members_v2',
  LEDGERS: 'hairstudio_ledgers_v2',
  SERVICES: 'hairstudio_services_v2',
  RECHARGE_PLANS: 'hairstudio_plans_v2',
  RECHARGE_SETTINGS: 'hairstudio_recharge_settings_v1',
  SNAPSHOTS: 'hairstudio_local_snapshots_v1',
  SAFETY_SNAPSHOT: 'hairstudio_pre_restore_safety_snapshot'
};
const PENDING_WRITE_KEY = 'hairstudio_pending_write_v1';
const activeStorageAccess = new WeakMap();

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

export function createLocalDb(localStorage, options = {}) {
let mutation = null;

function load(key, defaultVal = []) {
  recoverPendingWrite();
  const raw = localStorage.getItem(key);
  if (raw === null) return defaultVal;
  try {
    const data = JSON.parse(raw);
    if (key === STORAGE_KEYS.RECHARGE_SETTINGS) {
      if (data !== null) normalizeRechargeSettings(data);
    } else if (!Array.isArray(data)) throw new Error('数据结构不是数组');
    return data;
  } catch (e) {
    console.error('读取存储异常:', e);
    throw new Error(`本地账本数据异常（${key}），为避免覆盖请先恢复备份`);
  }
}

function save(key, data) {
  if (mutation && Object.values(STORAGE_KEYS).slice(0, 5).includes(key)) return saveBatch({ [key]: data });
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.error('写入存储异常:', e);
    throw new Error('本地存储写入失败，请检查可用空间后重试');
  }
}

function saveBatch(entries, { replaceJournal = false } = {}) {
  if (!replaceJournal) recoverPendingWrite();
  const previousJournal = replaceJournal ? localStorage.getItem(PENDING_WRITE_KEY) : null;
  if (mutation) assertAccountLimits(Object.fromEntries([
    ['members', STORAGE_KEYS.MEMBERS], ['ledgers', STORAGE_KEYS.LEDGERS],
    ['services', STORAGE_KEYS.SERVICES], ['rechargePlans', STORAGE_KEYS.RECHARGE_PLANS],
    ['rechargeSettings', STORAGE_KEYS.RECHARGE_SETTINGS]
  ].map(([field, key]) => [field, Object.hasOwn(entries, key) ? entries[key] : load(key, key === STORAGE_KEYS.RECHARGE_SETTINGS ? null : [])])));
  if (mutation && options.beforeWrite) entries = options.beforeWrite(entries, JSON.parse(JSON.stringify(mutation)));
  const writes = Object.entries(entries).map(([key, value]) => ({
    key,
    value: JSON.stringify(value),
    previous: localStorage.getItem(key)
  }));
  try {
    localStorage.setItem(PENDING_WRITE_KEY, JSON.stringify({ version: 1, writes, ...(previousJournal === null ? {} : { previousJournal }) }));
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
  if (mutation && options.afterWrite) {
    try { options.afterWrite(); } catch (error) { console.warn('账本已保存，后续同步通知失败:', error); }
  }
}

function recoverPendingWrite() {
  const raw = localStorage.getItem(PENDING_WRITE_KEY);
  if (raw === null) return;
  try {
    const pending = JSON.parse(raw);
    if (!pending || pending.version !== 1 || !Array.isArray(pending.writes) ||
        (pending.previousJournal !== undefined && typeof pending.previousJournal !== 'string') ||
        pending.writes.some(write => !write || typeof write.key !== 'string' || write.key === PENDING_WRITE_KEY ||
          (write.previous !== null && typeof write.previous !== 'string'))) throw new Error('恢复日志格式无效');
    // 全部校验通过后才回滚，避免坏日志前半段有效、后半段无效时改写账本。
    for (const write of [...pending.writes].reverse()) {
      if (localStorage.getItem(write.key) === write.previous) continue;
      if (write.previous === null) localStorage.removeItem(write.key);
      else localStorage.setItem(write.key, write.previous);
    }
    if (pending.previousJournal !== undefined) {
      localStorage.setItem(PENDING_WRITE_KEY, pending.previousJournal);
      recoverPendingWrite();
    } else localStorage.removeItem(PENDING_WRITE_KEY);
  } catch (error) {
    console.error('本地事务恢复失败:', error);
    throw new Error('检测到未完成的数据恢复；请勿清除应用数据，并尽快导出账本或联系支持');
  }
}

function rawRecoveryState() {
  return {
    storage: Object.fromEntries([
      STORAGE_KEYS.MEMBERS, STORAGE_KEYS.LEDGERS, STORAGE_KEYS.SERVICES, STORAGE_KEYS.RECHARGE_PLANS, STORAGE_KEYS.RECHARGE_SETTINGS
    ].map(key => [key, localStorage.getItem(key)])),
    pendingWrite: localStorage.getItem(PENDING_WRITE_KEY)
  };
}

function checkedSum(...values) {
  const result = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result)) throw new Error('累计金额超出可处理范围');
  return result;
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

  if (membersChanged || ledgersChanged) {
    saveBatch({
      [STORAGE_KEYS.MEMBERS]: members,
      [STORAGE_KEYS.LEDGERS]: ledgers
    });
  }
}

function generateId(prefix = '') {
  const id = options.generateId?.(prefix) || `${prefix}${globalThis.crypto?.randomUUID?.() ||
    Date.now().toString(36) + Math.random().toString(36).substring(2, 10)}`.toUpperCase();
  if (mutation && prefix !== 'SNP') mutation.generated.ids.push(id);
  return id;
}

function nowISO() {
  const value = options.now?.() || new Date().toISOString();
  if (mutation) mutation.generated.times.push(value);
  return value;
}

function csvText(value) {
  const text = String(value ?? '');
  // 引号只能转义 CSV 分隔符，文本前的公式符号还需单独处理。
  return /^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text) ? "'" + text : text;
}

const db = {
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

    // 初始化会员和流水
    if (localStorage.getItem(STORAGE_KEYS.MEMBERS) === null) {
      save(STORAGE_KEYS.MEMBERS, []);
    }
    if (localStorage.getItem(STORAGE_KEYS.LEDGERS) === null) {
      save(STORAGE_KEYS.LEDGERS, []);
    }

    removeUntouchedDemoData();
    const members = load(STORAGE_KEYS.MEMBERS);
    const restored = restoreArchivedMembers(members, normalizeRefunds(load(STORAGE_KEYS.LEDGERS)));
    if (restored.length !== members.length) save(STORAGE_KEYS.MEMBERS, restored);
    this.readBackupState();
  },

  // --- 会员管理 ---
  getMembers(query = '') {
    const members = load(STORAGE_KEYS.MEMBERS).filter(member => !member.isArchived);
    if (!query || !query.trim()) {
      return [...members].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    }
    const rawQuery = query.trim().toLowerCase();
    const cleanQuery = rawQuery.replace(/\D/g, '');
    return members.filter(m => {
      const nameMatch = m.name.toLowerCase().includes(rawQuery);
      const cleanPhone = (m.phone || '').replace(/\D/g, '');
      const phoneMatch = Boolean(cleanQuery && cleanPhone.includes(cleanQuery));
      return nameMatch || phoneMatch;
    }).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  },

  getMemberById(id) {
    const members = load(STORAGE_KEYS.MEMBERS);
    return members.find(m => m.id === id && !m.isArchived) || null;
  },

  createMember({ name, phone, initialBalance = 0, notes = '' }) {
    if (!name || !name.trim()) throw new Error('会员姓名不能为空');
    if (!phone || !phone.trim()) throw new Error('手机号码不能为空');

    const cleanPhone = normalizeMemberPhone(phone);
    const members = load(STORAGE_KEYS.MEMBERS);
    if (members.some(m => !m.isArchived && normalizeMemberPhone(m.phone) === cleanPhone)) {
      throw new Error(`手机号 ${cleanPhone} 已存在`);
    }

    const initCent = moneyToCent(initialBalance || 0, '开卡初始储值额');
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

    const nextMembers = [newMember, ...members];
    validateActiveMemberPhones(nextMembers);
    const nextLedgers = [...load(STORAGE_KEYS.LEDGERS)];
    if (initCent > 0) {
      nextLedgers.unshift(this.makeLedger({
        member: newMember,
        memberId: newMember.id,
        type: 'RECHARGE',
        changeAmount: initCent,
        balanceBefore: 0,
        balanceAfter: initCent,
        remark: '开卡初始存入额度'
      }));
    }

    saveBatch({
      [STORAGE_KEYS.MEMBERS]: nextMembers,
      [STORAGE_KEYS.LEDGERS]: nextLedgers
    });

    return newMember;
  },

  updateMember(id, { name, phone, notes }) {
    const members = load(STORAGE_KEYS.MEMBERS);
    const m = members.find(item => item.id === id);
    if (!m || m.isArchived) throw new Error('会员不存在或已注销');

    if (phone !== undefined) {
      if (typeof phone !== 'string' || !phone.trim()) throw new Error('手机号码不能为空');
      const cleanPhone = normalizeMemberPhone(phone);
      if (!cleanPhone) throw new Error('手机号码不能为空');
      if (members.some(item => !item.isArchived && item.id !== id && normalizeMemberPhone(item.phone) === cleanPhone)) {
        throw new Error(`手机号 ${cleanPhone} 已被其他会员占用`);
      }
      m.phone = cleanPhone;
    }

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) throw new Error('会员姓名不能为空');
      m.name = name.trim();
    }
    if (notes !== undefined) {
      if (typeof notes !== 'string') throw new Error('会员备注必须是文本');
      m.notes = notes.trim();
    }
    m.updated_at = nowISO();

    // Legacy accounts may contain several conflicting pairs. Repair one ID at
    // a time without rewriting historical phones or changing financial data.
    save(STORAGE_KEYS.MEMBERS, members);
    return m;
  },

  deleteMember(id) {
    const members = load(STORAGE_KEYS.MEMBERS);
    const m = members.find(item => item.id === id);
    if (!m) throw new Error('会员不存在');
    if (m.balance < 0) {
      throw new Error(`该会员尚有 ¥${(-m.balance/100).toFixed(2)} 欠款，请结清后再注销`);
    }
    if (m.balance > 0) {
      throw new Error(`该会员卡内尚有 ¥${(m.balance/100).toFixed(2)} 余额，请先扣除或清零后再删除`);
    }

    m.isArchived = true;
    m.deleted_at = nowISO();
    m.updated_at = m.deleted_at;
    save(STORAGE_KEYS.MEMBERS, members);
    return true;
  },

  // --- 充值记账 (强事务原子性) ---
  recharge({ memberId, actualPay, giftAmount = 0, payMethod = '', remark = '' }) {
    const members = load(STORAGE_KEYS.MEMBERS);
    const m = members.find(item => item.id === memberId);
    if (!m || m.isArchived) throw new Error('会员不存在或已注销');

    const actualCent = moneyToCent(actualPay || 0, '实收充值金额');
    const giftCent = moneyToCent(giftAmount || 0, '额外赠送额度');
    if (giftCent > 0 && !this.getRechargeSettings().giftEnabled) throw new Error('充值赠送已关闭，不可赠送金额');
    const totalCredit = checkedSum(actualCent, giftCent);
    if (totalCredit <= 0) throw new Error('充值总额必须大于0');

    const before = m.balance;
    const after = checkedSum(before, totalCredit);

    m.balance = after;
    m.total_recharge = checkedSum(m.total_recharge || 0, totalCredit);
    m.updated_at = nowISO();

    const channel = payMethod.trim() ? ` [${payMethod.trim()}]` : '';
    const remarkText = giftCent > 0
      ? `实充¥${(actualCent/100).toFixed(2)}，送¥${(giftCent/100).toFixed(2)}${channel}${remark ? ' ' + remark : ''}`
      : `充值¥${(actualCent/100).toFixed(2)}${channel}${remark ? ' ' + remark : ''}`;

    const ledger = this.makeLedger({
      member: m,
      memberId: m.id,
      type: 'RECHARGE',
      changeAmount: totalCredit,
      balanceBefore: before,
      balanceAfter: after,
      remark: remarkText
    });
    const ledgers = [ledger, ...load(STORAGE_KEYS.LEDGERS)];

    saveBatch({ [STORAGE_KEYS.MEMBERS]: members, [STORAGE_KEYS.LEDGERS]: ledgers });

    return {
      memberId: m.id,
      totalCredit,
      balanceAfter: after,
      ledgerId: ledger.id
    };
  },

  // --- 消费扣减：欠款须显式确认，余额与流水仍原子写入 ---
  consume({ memberId, amount, itemsSummary = '洗剪吹理发', remark = '', allowDebt = false }) {
    const members = load(STORAGE_KEYS.MEMBERS);
    const m = members.find(item => item.id === memberId);
    if (!m || m.isArchived) throw new Error('会员不存在或已注销');

    const amountCent = moneyToCent(amount, '消费扣款金额');
    if (amountCent <= 0) throw new Error('消费扣款金额必须大于0');
    const before = m.balance;
    const after = checkedSum(before, -amountCent);
    if (after < 0 && !allowDebt) {
      throw new Error(`扣款后将欠款 ¥${(-after/100).toFixed(2)}，请确认欠款后再扣款`);
    }

    m.balance = after;
    m.total_consume = checkedSum(m.total_consume || 0, amountCent);
    m.updated_at = nowISO();

    const debtAdded = Math.max(0, -after) - Math.max(0, -before);
    const detail = itemsSummary + (remark ? ` (${remark})` : '') + (after < 0
      ? ` [已确认欠款：本次新增¥${(debtAdded/100).toFixed(2)}，累计¥${(-after/100).toFixed(2)}]` : '');
    const ledger = this.makeLedger({
      member: m,
      memberId: m.id,
      type: 'CONSUME',
      changeAmount: -amountCent,
      balanceBefore: before,
      balanceAfter: after,
      remark: detail
    });
    const ledgers = [ledger, ...load(STORAGE_KEYS.LEDGERS)];

    saveBatch({ [STORAGE_KEYS.MEMBERS]: members, [STORAGE_KEYS.LEDGERS]: ledgers });

    return {
      memberId: m.id,
      deductedAmount: amountCent,
      balanceAfter: after,
      ledgerId: ledger.id
    };
  },

  // --- 核心安全：错录撤回 / 红冲退款 (防止店主输错金额) ---
  refundLedger(ledgerId, reason = '店主手工撤销', allowDebt = false) {
    const ledgers = normalizeRefunds(load(STORAGE_KEYS.LEDGERS));
    const target = ledgers.find(l => l.id === ledgerId);
    if (!target) throw new Error('未找到该流水记录');
    if (target.isRefunded) throw new Error('该笔记录已被撤销过，不可重复撤销');

    const members = load(STORAGE_KEYS.MEMBERS);
    const m = members.find(item => item.id === target.memberId);
    if (!m) throw new Error('关联会员不存在');
    if (m.isArchived && members.some(member => !member.isArchived && member.id !== m.id && normalizeMemberPhone(member.phone) === normalizeMemberPhone(m.phone))) {
      throw new Error('该手机号已用于其他会员，请先修改该会员手机号，再撤销已注销档案的消费');
    }

    const before = m.balance;
    let after = before;
    let refundAmount = 0;
    let refundRemark = '';

    if (target.type === 'CONSUME') {
      // 原来是消费扣款（负数），撤销需要补回会员余额
      const restoreAmount = Math.abs(target.changeAmount);
      after = checkedSum(before, restoreAmount);
      m.balance = after;
      m.total_consume = Math.max(0, (m.total_consume || 0) - restoreAmount);
      refundAmount = restoreAmount;
      refundRemark = `[撤销扣款冲正] 恢复¥${(restoreAmount/100).toFixed(2)} 原单号:${target.id} (${reason})`;
    } else if (target.type === 'RECHARGE') {
      // 原来是充值增加，撤销需要扣减会员余额
      const deductAmount = target.changeAmount;
      after = checkedSum(before, -deductAmount);
      if (after < 0 && !allowDebt) {
        throw new Error(`撤销充值后将欠款 ¥${(-after/100).toFixed(2)}，请确认欠款后再撤销`);
      }
      m.balance = after;
      m.total_recharge = Math.max(0, (m.total_recharge || 0) - deductAmount);
      refundAmount = -deductAmount;
      refundRemark = `[撤销充值冲正] 扣除¥${(deductAmount/100).toFixed(2)} 原单号:${target.id} (${reason})`;
    } else {
      throw new Error('该记录类型不支持撤销');
    }

    target.isRefunded = true;
    if (m.isArchived && after !== 0) {
      if (!normalizeMemberPhone(m.phone)) throw new Error('该注销会员缺少手机号，无法重新启用；请先核对并恢复完整会员档案后再撤销');
      m.isArchived = false;
      delete m.deleted_at;
      validateActiveMemberPhones(members);
    }
    m.updated_at = nowISO();
    // 记录冲正流水
    const refundLedgerRecord = {
      id: generateId('TX'),
      memberId: m.id,
      memberName: m.name,
      memberPhone: m.phone,
      type: 'REFUND',
      originalLedgerId: target.id,
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
    let ledgers = normalizeRefunds(load(STORAGE_KEYS.LEDGERS));
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

  getRechargeSettings() {
    return normalizeRechargeSettings(load(STORAGE_KEYS.RECHARGE_SETTINGS, null) ?? undefined);
  },

  saveRechargeSettings(settings) {
    const validated = normalizeRechargeSettings(settings);
    save(STORAGE_KEYS.RECHARGE_SETTINGS, validated);
    return validated;
  },

  saveService(item) {
    const services = this.getServices();
    if (!item.name || !item.name.trim()) throw new Error('项目名称必填');
    const price = moneyToCent(item.price, '项目价格') / 100;

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
    const ledgers = normalizeRefunds(load(STORAGE_KEYS.LEDGERS));

    const totalBalance = members.reduce((sum, m) => sum + (m.balance || 0), 0);
    const totalCreditBalance = members.reduce((sum, m) => sum + Math.max(0, m.balance || 0), 0);
    const totalDebt = members.reduce((sum, m) => sum + Math.max(0, -(m.balance || 0)), 0);
    const totalRecharge = members.reduce((sum, m) => sum + (m.total_recharge || 0), 0);
    const totalConsume = members.reduce((sum, m) => sum + (m.total_consume || 0), 0);

    const todayStr = new Date().toDateString();
    let todayRechargeCredit = 0;
    let todayRechargeCount = 0;
    let todayConsumeAmount = 0;
    let todayConsumeCount = 0;

    for (const l of ledgers) {
      if (!l.isRefunded && new Date(l.created_at).toDateString() === todayStr) {
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
      memberCount: members.filter(member => !member.isArchived).length,
      totalBalance,
      totalCreditBalance,
      totalDebt,
      debtMemberCount: members.filter(member => !member.isArchived && member.balance < 0).length,
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

  // --- 备份解析与格式校验内部工具 ---
  parseAndValidateBackup(jsonString, { allowPhoneConflicts = false } = {}) {
    if (typeof jsonString !== 'string') throw new Error('备份必须是 JSON 文本');
    if (byteLength(jsonString) > DATA_LIMITS.backupBytes) throw new DataLimitError('备份文件过大');
    let parsed;
    try {
      parsed = JSON.parse(jsonString);
    } catch {
      throw new Error('备份文件不是合法的JSON文本');
    }
    assertJsonBudget(parsed, DATA_LIMITS.backupBytes);
    if (!parsed || !parsed.data || !Array.isArray(parsed.data.members)) {
      throw new Error('备份文件格式不正确，缺少会员名册数据');
    }
    let { members } = parsed.data;
    let ledgers = parsed.data.ledgers ?? [];
    const services = parsed.data.services ?? DEFAULT_SERVICES;
    const rechargePlans = parsed.data.rechargePlans ?? DEFAULT_RECHARGE_PLANS;
    const rechargeSettings = parsed.data.rechargeSettings === undefined ? undefined : normalizeRechargeSettings(parsed.data.rechargeSettings);
    if (!Array.isArray(ledgers) || !Array.isArray(services) || !Array.isArray(rechargePlans)) {
      throw new Error('备份文件中的流水、服务项目或充值档位格式不正确');
    }
    assertAccountLimits({ members, ledgers, services, rechargePlans });
    const memberIds = new Set();
    for (const member of members) {
      if (!member || typeof member.id !== 'string' || !member.id || memberIds.has(member.id) ||
          typeof member.name !== 'string' || !member.name.trim() || typeof member.phone !== 'string' ||
          !Number.isSafeInteger(member.balance) ||
          !Number.isSafeInteger(member.total_recharge) || member.total_recharge < 0 ||
          !Number.isSafeInteger(member.total_consume) || member.total_consume < 0 ||
          member.balance !== member.total_recharge - member.total_consume ||
          (member.isArchived !== undefined && typeof member.isArchived !== 'boolean') ||
          (member.isArchived && member.balance !== 0) ||
          (member.notes != null && typeof member.notes !== 'string')) {
        throw new Error('备份文件包含无效或重复的会员数据');
      }
      memberIds.add(member.id);
    }
    members = members.map(member => ({ ...member, notes: member.notes ?? '' }));
    const ledgerIds = new Set();
    for (const ledger of ledgers) {
      if (!ledger || typeof ledger.id !== 'string' || !ledger.id || ledgerIds.has(ledger.id) ||
          typeof ledger.memberId !== 'string' || !ledger.memberId ||
          !['RECHARGE', 'CONSUME', 'REFUND'].includes(ledger.type) ||
          !Number.isSafeInteger(ledger.changeAmount) || !Number.isSafeInteger(ledger.balanceBefore) ||
          !Number.isSafeInteger(ledger.balanceAfter) ||
          ledger.balanceAfter - ledger.balanceBefore !== ledger.changeAmount ||
          (ledger.type === 'RECHARGE' && ledger.changeAmount <= 0) ||
          (ledger.type === 'CONSUME' && ledger.changeAmount >= 0) || ledger.changeAmount === 0 ||
          (ledger.isRefunded !== undefined && typeof ledger.isRefunded !== 'boolean') ||
          typeof ledger.created_at !== 'string' ||
          Number.isNaN(Date.parse(ledger.created_at)) ||
          ['memberName', 'memberPhone', 'remark'].some(field => ledger[field] != null && typeof ledger[field] !== 'string')) {
        throw new Error('备份文件包含无效的流水数据');
      }
      ledgerIds.add(ledger.id);
    }
    // 旧备份可能缺少显示字段；只补齐缺失文本，不覆盖已记录的历史姓名和电话。
    const membersById = new Map(members.map(member => [member.id, member]));
    ledgers = ledgers.map(ledger => ({
      ...ledger,
      memberName: ledger.memberName ?? membersById.get(ledger.memberId)?.name ?? '已注销会员',
      memberPhone: ledger.memberPhone ?? membersById.get(ledger.memberId)?.phone ?? '',
      remark: ledger.remark ?? ''
    }));
    ledgers = normalizeRefunds(ledgers);
    members = restoreArchivedMembers(members, ledgers);
    if (!allowPhoneConflicts) validateActiveMemberPhones(members);
    validateAccountHistory(members, ledgers);
    if (services.some(item => !item || typeof item.id !== 'string' || typeof item.name !== 'string' ||
        !item.name.trim() || !Number.isFinite(item.price) || item.price < 0)) {
      throw new Error('备份文件包含无效的服务项目');
    }
    for (const service of services) moneyToCent(service.price, '服务项目价格');
    if (rechargePlans.some(plan => !plan || !Number.isFinite(plan.pay) || plan.pay <= 0 ||
        !Number.isFinite(plan.gift) || plan.gift < 0)) {
      throw new Error('备份文件包含无效的充值档位');
    }
    for (const plan of rechargePlans) {
      moneyToCent(plan.pay, '充值档位金额');
      moneyToCent(plan.gift, '赠送金额');
    }

    assertAccountLimits({ members, ledgers, services, rechargePlans });
    return {
      version: parsed.version || '2.0',
      exportedAt: parsed.exportedAt || null,
      appName: parsed.appName || '梦飞空间会员管家',
      data: { members, ledgers, services, rechargePlans, ...(rechargeSettings === undefined ? {} : { rechargeSettings }) }
    };
  },

  readBackupState() {
    const rechargeSettings = load(STORAGE_KEYS.RECHARGE_SETTINGS, null);
    return this.parseAndValidateBackup(JSON.stringify({ data: {
      members: load(STORAGE_KEYS.MEMBERS), ledgers: load(STORAGE_KEYS.LEDGERS),
      services: load(STORAGE_KEYS.SERVICES, DEFAULT_SERVICES),
      rechargePlans: load(STORAGE_KEYS.RECHARGE_PLANS, DEFAULT_RECHARGE_PLANS),
      ...(rechargeSettings === null ? {} : { rechargeSettings })
    } }), { allowPhoneConflicts: true }).data;
  },

  readRecoveryState() {
    const original = rawRecoveryState();
    try { recoverPendingWrite(); }
    catch (error) { return { ...original, data: null, dataError: error.message }; }
    const current = rawRecoveryState();
    try { return { ...current, data: this.readBackupState(), dataError: '' }; }
    catch (error) { return { ...current, data: null, dataError: error.message }; }
  },

  applyCloudSnapshot(data, metadataKey, metadata, { allowRecovery = false, allowPhoneConflicts = false } = {}) {
    if (mutation) throw new Error('不能在记账过程中替换云端账本');
    const validated = this.parseAndValidateBackup(JSON.stringify({ data }), { allowPhoneConflicts }).data;
    let replaceJournal = false;
    if (allowRecovery) {
      const recovery = this.readRecoveryState();
      if (recovery.dataError) {
        save(STORAGE_KEYS.SAFETY_SNAPSHOT, { timestamp: nowISO(), storage: recovery.storage, pendingWrite: recovery.pendingWrite, dataError: recovery.dataError });
        replaceJournal = recovery.pendingWrite !== null;
      }
    }
    saveBatch({
      [STORAGE_KEYS.MEMBERS]: validated.members, [STORAGE_KEYS.LEDGERS]: validated.ledgers,
      [STORAGE_KEYS.SERVICES]: validated.services, [STORAGE_KEYS.RECHARGE_PLANS]: validated.rechargePlans,
      [STORAGE_KEYS.RECHARGE_SETTINGS]: validated.rechargeSettings ?? null,
      [metadataKey]: metadata
    }, { replaceJournal });
  },

  // --- 智能对账与备份预览 (对比现有数据与备份数据，防止覆盖新数据) ---
  previewBackup(jsonString) {
    const validated = this.parseAndValidateBackup(jsonString);
    const { members: backupMembers, ledgers: backupLedgers } = validated.data;

    let currentDataError = '';
    let current = { members: [], ledgers: [], services: [], rechargePlans: [] };
    try {
      current = this.readBackupState();
    } catch (error) {
      currentDataError = error.message;
    }
    const { members: currentMembers, ledgers: currentLedgers } = current;
    let mergeError = currentDataError;
    if (!mergeError) {
      try { mergeAccounts(current, validated.data); }
      catch (error) { mergeError = error.message; }
    }

    const incomingMemberIds = new Set(backupMembers.map(member => member.id));
    const currentPhoneMap = new Map();
    for (const m of currentMembers) {
      if (!m.isArchived && m.phone && !incomingMemberIds.has(m.id)) currentPhoneMap.set(normalizeMemberPhone(m.phone), m);
    }
    const currentMemberIdSet = new Set(currentMembers.map(member => member.id));

    const currentLedgerIdSet = new Set(currentLedgers.map(l => l.id));

    let newMembersCount = 0;
    let existingMembersCount = 0;
    for (const bm of backupMembers) {
      const cleanPhone = normalizeMemberPhone(bm.phone || '');
      if (currentMemberIdSet.has(bm.id) || (!bm.isArchived && currentPhoneMap.has(cleanPhone))) {
        existingMembersCount++;
      } else {
        newMembersCount++;
      }
    }

    let newLedgersCount = 0;
    let duplicateLedgersCount = 0;
    for (const bl of backupLedgers) {
      if (currentLedgerIdSet.has(bl.id)) {
        duplicateLedgersCount++;
      } else {
        newLedgersCount++;
      }
    }

    // 检查当前系统是否包含比备份更新的开单或充值
    const backupExportTime = validated.exportedAt ? Date.parse(validated.exportedAt) : 0;
    let currentNewerTransactionsCount = 0;
    if (backupExportTime > 0) {
      for (const l of currentLedgers) {
        if (Date.parse(l.created_at) > backupExportTime) {
          currentNewerTransactionsCount++;
        }
      }
    }

    const backupTotalBalance = backupMembers.reduce((sum, m) => sum + (m.balance || 0), 0);
    const currentTotalBalance = currentMembers.reduce((sum, m) => sum + (m.balance || 0), 0);

    return {
      isValid: true,
      currentDataError,
      mergeError,
      exportedAt: validated.exportedAt,
      appName: validated.appName,
      backupStats: {
        memberCount: backupMembers.filter(member => !member.isArchived).length,
        ledgerCount: backupLedgers.length,
        totalBalance: backupTotalBalance
      },
      currentStats: {
        memberCount: currentMembers.filter(member => !member.isArchived).length,
        ledgerCount: currentLedgers.length,
        totalBalance: currentTotalBalance
      },
      diff: {
        newMembersCount,
        existingMembersCount,
        newLedgersCount,
        duplicateLedgersCount,
        currentNewerTransactionsCount,
        hasNewerLocalData: currentNewerTransactionsCount > 0
      }
    };
  },

  // --- 本地快照与备份历史管理 ---
  getLocalSnapshots() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SNAPSHOTS);
      if (!raw) return [];
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  },

  saveLocalSnapshot(tag = '手动备份', reason = '', explicitData = null) {
    try {
      const snapshots = this.getLocalSnapshots();
      const data = explicitData ? this.parseAndValidateBackup(JSON.stringify({ data: explicitData })).data : this.readBackupState();
      const { members, ledgers, services, rechargePlans } = data;

      const now = nowISO();
      const datePart = now.split('T')[0];
      const timePart = now.substring(11, 16).replace(':', '');
      const fileName = `梦飞空间会员账本备份_${datePart}_${timePart}.json`;

      const totalBalance = members.reduce((sum, m) => sum + (m.balance || 0), 0);

      const snapshot = {
        id: generateId('SNP'),
        createdAt: now,
        fileName,
        tag,
        reason,
        memberCount: members.filter(member => !member.isArchived).length,
        ledgerCount: ledgers.length,
        totalBalance,
        content: JSON.stringify({
          version: '2.0',
          exportedAt: now,
          appName: '梦飞空间会员管家',
          data
        }, null, 2)
      };

      snapshots.unshift(snapshot);
      // 保留最近 10 份历史快照
      if (snapshots.length > 10) snapshots.length = 10;
      localStorage.setItem(STORAGE_KEYS.SNAPSHOTS, JSON.stringify(snapshots));
      return snapshot;
    } catch (e) {
      console.warn('保存本地快照失败:', e);
      throw new Error('本地快照保存失败，请检查可用空间后重试');
    }
  },

  deleteLocalSnapshot(id) {
    try {
      let snapshots = this.getLocalSnapshots();
      snapshots = snapshots.filter(s => s.id !== id);
      localStorage.setItem(STORAGE_KEYS.SNAPSHOTS, JSON.stringify(snapshots));
      return true;
    } catch {
      throw new Error('删除本地快照失败，请重试');
    }
  },

  // 获取标准导出保存目录说明
  getExportDirectoryInfo() {
    return {
      downloadPath: '安卓：系统分享面板中选择保存位置；浏览器：查看下载记录',
      wechatPath: '微信 > 文件传输助手（请另存文件并定期核对）',
      hint: '导出后通过系统分享发送给微信或文件管理器。请确认接收端文件可打开，并另外保存一份备份。'
    };
  },

  // --- 微信/本地一键备份导出 ---
  exportBackupData({ archiveSnapshot = true } = {}) {
    const data = this.readBackupState();

    const now = nowISO();
    const backup = {
      version: '2.0',
      exportedAt: now,
      appName: '梦飞空间会员管家',
      data
    };
    const content = JSON.stringify(backup, null, 2);

    // 导出时自动在应用内生成一份备份快照，方便在App界面即时看到检测到的备份文件
    if (archiveSnapshot) {
      this.saveLocalSnapshot('导出生成快照', '用户执行一键备份导出', data);
    }

    return content;
  },

  // --- 备份恢复 (支持智能安全合并模式与全量覆盖模式) ---
  importBackupData(jsonString, options = {}) {
    const mode = options.mode || 'replace';
    if (!['replace', 'merge'].includes(mode)) throw new Error('不支持的恢复模式');
    const validated = this.parseAndValidateBackup(jsonString);
    const { services: backupServices, rechargePlans: backupPlans } = validated.data;
    let next = validated.data;
    let summary = { newMembersAdded: 0, newLedgersAdded: 0, updatedMembers: 0 };
    if (mode === 'merge') {
      const current = this.readBackupState();
      summary = mergeAccounts(current, validated.data);
      const currentServices = current.services;
      const currentPlans = current.rechargePlans;
      const serviceNames = new Set(currentServices.map(s => s.name));
      for (const bs of backupServices) {
        if (!serviceNames.has(bs.name)) {
          currentServices.push({ ...bs, id: generateId('S') });
          serviceNames.add(bs.name);
        }
      }

      const planKeys = new Set(currentPlans.map(p => `${p.pay}_${p.gift}`));
      for (const bp of backupPlans) {
        const key = `${bp.pay}_${bp.gift}`;
        if (!planKeys.has(key)) {
          currentPlans.push(bp);
          planKeys.add(key);
        }
      }

      next = { members: summary.members, ledgers: summary.ledgers, services: currentServices, rechargePlans: currentPlans,
        ...(current.rechargeSettings === undefined ? {} : { rechargeSettings: current.rechargeSettings }) };
    }

    // 保留原始文本，损坏的 JSON 也可以在全量恢复后取回。保存失败则禁止覆盖。
    const recovery = this.readRecoveryState();
    if (mode === 'merge' && recovery.dataError) throw new Error(recovery.dataError);
    save(STORAGE_KEYS.SAFETY_SNAPSHOT, { timestamp: nowISO(), storage: recovery.storage, pendingWrite: recovery.pendingWrite, dataError: recovery.dataError });
    saveBatch({
      [STORAGE_KEYS.MEMBERS]: next.members, [STORAGE_KEYS.LEDGERS]: next.ledgers,
      [STORAGE_KEYS.SERVICES]: next.services, [STORAGE_KEYS.RECHARGE_PLANS]: next.rechargePlans,
      [STORAGE_KEYS.RECHARGE_SETTINGS]: next.rechargeSettings ?? null
    }, { replaceJournal: Boolean(recovery.dataError && recovery.pendingWrite !== null) });
    let snapshotSaved = true;
    try {
      this.saveLocalSnapshot(mode === 'merge' ? '增量合并后备份' : '完全覆盖后备份', '恢复完成');
    } catch {
      snapshotSaved = false;
    }
    return {
      success: true, mode, count: next.members.filter(member => !member.isArchived).length,
      newMembersAdded: summary.newMembersAdded, newLedgersAdded: summary.newLedgersAdded,
      updatedMembers: summary.updatedMembers, snapshotSaved
    };
  },

  exportCSV() {
    const ledgers = normalizeRefunds(load(STORAGE_KEYS.LEDGERS));
    let csv = '\uFEFF流水单号,会员姓名,联系电话,流水类型,变动额度(元),变动后余额(元),明细备注,记录时间\n';
    for (const l of ledgers) {
      let typeText = '消费扣款';
      if (l.type === 'RECHARGE') typeText = '储值入账';
      if (l.type === 'REFUND') typeText = '撤销冲正';
      const changeYuan = (l.changeAmount / 100).toFixed(2);
      const afterYuan = (l.balanceAfter / 100).toFixed(2);
      const time = new Date(l.created_at).toLocaleString();
      const fields = [csvText(l.id), csvText(l.memberName), csvText(l.memberPhone), typeText,
        changeYuan, afterYuan, csvText(l.remark), time];
      csv += fields.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',') + '\n';
    }
    return csv;
  }
};

for (const method of ['createMember', 'updateMember', 'deleteMember', 'recharge', 'consume',
  'refundLedger', 'recordLedger', 'saveService', 'deleteService', 'saveRechargeSettings', 'importBackupData']) {
  const implementation = db[method];
  db[method] = function (...args) {
    if (mutation) throw new Error('不能嵌套执行账本变更');
    validateMutationArgs(method, args);
    if (['createMember', 'deleteMember', 'recharge', 'consume', 'refundLedger', 'recordLedger'].includes(method)) {
      validateActiveMemberPhones(load(STORAGE_KEYS.MEMBERS));
    }
    mutation = { method, args: JSON.parse(JSON.stringify(args)), generated: { ids: [], times: [] } };
    try { return implementation.apply(this, args); } finally { mutation = null; }
  };
}
// Distinct databases in one runtime must not recover each other's live journal.
// Browser runtimes are additionally serialized by the page's Web Lock.
for (const method of Object.keys(db)) {
  const implementation = db[method];
  db[method] = function (...args) {
    const owner = localStorage && activeStorageAccess.get(localStorage);
    if (owner && owner !== db) throw Object.assign(new Error('账本正在记账，请稍后重试'), { code: 'LEDGER_BUSY' });
    if (localStorage && !owner) activeStorageAccess.set(localStorage, db);
    try { return implementation.apply(this, args); }
    finally { if (localStorage && !owner) activeStorageAccess.delete(localStorage); }
  };
}
return db;
}

const currentStorage = Object.fromEntries(['getItem', 'setItem', 'removeItem'].map(method =>
  [method, (...args) => { assertLedgerAccess(); return globalThis.localStorage[method](...args); }]));
let writeInterceptor = null;
let writeListener = null;
export function configureCloudWrites(beforeWrite, afterWrite) {
  writeInterceptor = beforeWrite;
  writeListener = afterWrite;
  return () => {
    if (writeInterceptor === beforeWrite && writeListener === afterWrite) {
      writeInterceptor = null; writeListener = null;
    }
  };
}
export const localDb = createLocalDb(currentStorage, {
  beforeWrite: (entries, operation) => writeInterceptor?.(entries, operation) || entries,
  afterWrite: () => writeListener?.()
});
