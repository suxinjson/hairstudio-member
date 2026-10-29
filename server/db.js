import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'member_ledger.db');
const db = new DatabaseSync(DB_PATH);

// 开启 WAL 模式以提升高并发读写性能与可靠性
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// 初始化表结构
db.exec(`
  -- 会员信息表
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    balance INTEGER NOT NULL DEFAULT 0,          -- 当前可用余额（单位：分）
    total_recharge INTEGER NOT NULL DEFAULT 0,   -- 历史累计充值额度（分）
    total_consume INTEGER NOT NULL DEFAULT 0,    -- 历史累计消费额度（分）
    status TEXT NOT NULL DEFAULT 'ACTIVE',       -- ACTIVE, FROZEN
    notes TEXT,                                  -- 会员备注/生日/偏好等
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- 充值记录表
  CREATE TABLE IF NOT EXISTS recharge_orders (
    id TEXT PRIMARY KEY,
    order_no TEXT NOT NULL UNIQUE,
    member_id TEXT NOT NULL,
    actual_pay INTEGER NOT NULL,                 -- 实付金额（分）
    gift_amount INTEGER NOT NULL DEFAULT 0,      -- 赠送金额（分）
    total_credit INTEGER NOT NULL,               -- 入账总额度（分）
    pay_method TEXT NOT NULL,                    -- WECHAT, ALIPAY, CASH, BANK, OTHER
    operator TEXT DEFAULT '管理员',
    remark TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (member_id) REFERENCES members(id)
  );

  -- 消费扣款记录表
  CREATE TABLE IF NOT EXISTS consume_orders (
    id TEXT PRIMARY KEY,
    order_no TEXT NOT NULL UNIQUE,
    member_id TEXT NOT NULL,
    amount INTEGER NOT NULL,                     -- 扣减金额（分）
    items_summary TEXT NOT NULL,                 -- 消费项目/摘要
    operator TEXT DEFAULT '管理员',
    remark TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (member_id) REFERENCES members(id)
  );

  -- 财务不可变流水账本表
  CREATE TABLE IF NOT EXISTS ledger_records (
    id TEXT PRIMARY KEY,
    record_no TEXT NOT NULL UNIQUE,
    member_id TEXT NOT NULL,
    type TEXT NOT NULL,                          -- RECHARGE(充值), CONSUME(消费), REFUND(退款/冲正), ADJUST(人工调整)
    change_amount INTEGER NOT NULL,              -- 变动金额(分)，充值为正，消费为负
    balance_before INTEGER NOT NULL,             -- 变动前可用余额(分)
    balance_after INTEGER NOT NULL,              -- 变动后可用余额(分)
    ref_order_id TEXT,                           -- 关联的充值单号或消费单号
    operator TEXT DEFAULT '管理员',
    remark TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (member_id) REFERENCES members(id)
  );

  -- 索引
  CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone);
  CREATE INDEX IF NOT EXISTS idx_members_name ON members(name);
  CREATE INDEX IF NOT EXISTS idx_ledger_member ON ledger_records(member_id);
  CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger_records(created_at);
  CREATE INDEX IF NOT EXISTS idx_recharge_member ON recharge_orders(member_id);
  CREATE INDEX IF NOT EXISTS idx_consume_member ON consume_orders(member_id);
`);

function generateId(prefix = '') {
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).substring(2, 7);
  return `${prefix}${timestamp}${randomStr}`.toUpperCase();
}

function nowISO() {
  return new Date().toISOString();
}

export const dbService = {
  // --- 会员管理 ---
  getMembers({ query = '', limit = 50, offset = 0 } = {}) {
    let sql = 'SELECT * FROM members';
    const params = [];
    if (query && query.trim()) {
      const q = `%${query.trim()}%`;
      sql += ' WHERE name LIKE ? OR phone LIKE ?';
      params.push(q, q);
    }
    sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = db.prepare(sql);
    return stmt.all(...params);
  },

  getMemberById(id) {
    const stmt = db.prepare('SELECT * FROM members WHERE id = ?');
    return stmt.get(id);
  },

  getMemberByPhone(phone) {
    const stmt = db.prepare('SELECT * FROM members WHERE phone = ?');
    return stmt.get(phone.trim());
  },

  createMember({ name, phone, initialBalance = 0, notes = '' }) {
    if (!name || !phone) {
      throw new Error('姓名和手机号不能为空');
    }
    const cleanPhone = phone.trim();
    const existing = this.getMemberByPhone(cleanPhone);
    if (existing) {
      throw new Error(`手机号 ${cleanPhone} 已存在，会员姓名：${existing.name}`);
    }

    const id = generateId('M');
    const now = nowISO();
    const initCent = Math.round(Number(initialBalance || 0) * 100);

    // 事务创建
    db.exec('BEGIN TRANSACTION;');
    try {
      const insertMember = db.prepare(`
        INSERT INTO members (id, name, phone, balance, total_recharge, total_consume, status, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, 'ACTIVE', ?, ?, ?)
      `);
      insertMember.run(id, name.trim(), cleanPhone, initCent, initCent, notes.trim(), now, now);

      if (initCent > 0) {
        // 如果有初始赠额/储值，写入流水
        const recordNo = generateId('TX');
        const insertLedger = db.prepare(`
          INSERT INTO ledger_records (id, record_no, member_id, type, change_amount, balance_before, balance_after, operator, remark, created_at)
          VALUES (?, ?, ?, 'RECHARGE', ?, 0, ?, '系统初始化', '初始录入额度', ?)
        `);
        insertLedger.run(generateId('L'), recordNo, id, initCent, initCent, now);
      }

      db.exec('COMMIT;');
      return this.getMemberById(id);
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  },

  updateMember(id, { name, phone, notes, status }) {
    const member = this.getMemberById(id);
    if (!member) throw new Error('会员不存在');

    const cleanPhone = phone ? phone.trim() : member.phone;
    if (cleanPhone !== member.phone) {
      const existing = this.getMemberByPhone(cleanPhone);
      if (existing && existing.id !== id) {
        throw new Error(`手机号 ${cleanPhone} 已被其他会员占用`);
      }
    }

    const stmt = db.prepare(`
      UPDATE members
      SET name = ?, phone = ?, notes = ?, status = ?, updated_at = ?
      WHERE id = ?
    `);
    const now = nowISO();
    stmt.run(
      name ? name.trim() : member.name,
      cleanPhone,
      notes !== undefined ? notes : member.notes,
      status || member.status,
      now,
      id
    );
    return this.getMemberById(id);
  },

  // --- 充值记账 (强事务) ---
  recharge({ memberId, actualPay, giftAmount = 0, payMethod = 'WECHAT', operator = '前台收银', remark = '' }) {
    const member = this.getMemberById(memberId);
    if (!member) throw new Error('会员不存在');
    if (member.status === 'FROZEN') throw new Error('该会员已被冻结，无法充值');

    const actualCent = Math.round(Number(actualPay) * 100);
    const giftCent = Math.round(Number(giftAmount) * 100);
    if (isNaN(actualCent) || actualCent < 0) throw new Error('实付金额必须大于等于0');
    if (isNaN(giftCent) || giftCent < 0) throw new Error('赠送金额必须大于等于0');
    const totalCredit = actualCent + giftCent;
    if (totalCredit <= 0) throw new Error('充值总额度必须大于0');

    db.exec('BEGIN TRANSACTION;');
    try {
      const now = nowISO();
      const orderId = generateId('RC');
      const orderNo = `RC${Date.now()}`;

      // 1. 写入充值记录单
      const insertOrder = db.prepare(`
        INSERT INTO recharge_orders (id, order_no, member_id, actual_pay, gift_amount, total_credit, pay_method, operator, remark, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertOrder.run(orderId, orderNo, memberId, actualCent, giftCent, totalCredit, payMethod, operator, remark, now);

      // 2. 取当前最新余额与计算
      const beforeBalance = member.balance;
      const afterBalance = beforeBalance + totalCredit;

      // 3. 写入不可变账本流水
      const ledgerId = generateId('L');
      const recordNo = `TX${Date.now()}`;
      const insertLedger = db.prepare(`
        INSERT INTO ledger_records (id, record_no, member_id, type, change_amount, balance_before, balance_after, ref_order_id, operator, remark, created_at)
        VALUES (?, ?, ?, 'RECHARGE', ?, ?, ?, ?, ?, ?, ?)
      `);
      const remarkText = giftCent > 0 
        ? `实充¥${(actualCent/100).toFixed(2)}，赠送¥${(giftCent/100).toFixed(2)}${remark ? ` (${remark})` : ''}`
        : (remark || `充值¥${(actualCent/100).toFixed(2)}`);

      insertLedger.run(ledgerId, recordNo, memberId, totalCredit, beforeBalance, afterBalance, orderId, operator, remarkText, now);

      // 4. 原子更新会员余额与累计充值
      const updateMember = db.prepare(`
        UPDATE members 
        SET balance = balance + ?, total_recharge = total_recharge + ?, updated_at = ?
        WHERE id = ?
      `);
      updateMember.run(totalCredit, totalCredit, now, memberId);

      db.exec('COMMIT;');
      return {
        orderId,
        orderNo,
        memberId,
        totalCredit,
        balanceAfter: afterBalance,
        created_at: now
      };
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  },

  // --- 消费扣减 (强事务 + 乐观行锁防超扣) ---
  consume({ memberId, amount, itemsSummary = '会员到店消费', operator = '前台收银', remark = '' }) {
    const member = this.getMemberById(memberId);
    if (!member) throw new Error('会员不存在');
    if (member.status === 'FROZEN') throw new Error('该会员已被冻结，无法消费扣款');

    const amountCent = Math.round(Number(amount) * 100);
    if (isNaN(amountCent) || amountCent <= 0) {
      throw new Error('消费扣款金额必须大于0');
    }

    if (member.balance < amountCent) {
      throw new Error(`会员余额不足！当前余额：¥${(member.balance / 100).toFixed(2)}，扣款金额：¥${(amountCent / 100).toFixed(2)}`);
    }

    db.exec('BEGIN TRANSACTION;');
    try {
      const now = nowISO();
      const orderId = generateId('CS');
      const orderNo = `CS${Date.now()}`;

      // 1. 写入消费记录单
      const insertOrder = db.prepare(`
        INSERT INTO consume_orders (id, order_no, member_id, amount, items_summary, operator, remark, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertOrder.run(orderId, orderNo, memberId, amountCent, itemsSummary, operator, remark, now);

      // 2. 取当前最新余额与计算
      const beforeBalance = member.balance;
      const afterBalance = beforeBalance - amountCent;

      // 3. 写入不可变账本流水（负数表示扣除）
      const ledgerId = generateId('L');
      const recordNo = `TX${Date.now()}`;
      const insertLedger = db.prepare(`
        INSERT INTO ledger_records (id, record_no, member_id, type, change_amount, balance_before, balance_after, ref_order_id, operator, remark, created_at)
        VALUES (?, ?, ?, 'CONSUME', ?, ?, ?, ?, ?, ?, ?)
      `);
      insertLedger.run(ledgerId, recordNo, memberId, -amountCent, beforeBalance, afterBalance, orderId, operator, itemsSummary + (remark ? ` - ${remark}` : ''), now);

      // 4. 原子扣减会员余额并校验 balance >= amountCent
      const updateMember = db.prepare(`
        UPDATE members 
        SET balance = balance - ?, total_consume = total_consume + ?, updated_at = ?
        WHERE id = ? AND balance >= ?
      `);
      const res = updateMember.run(amountCent, amountCent, now, memberId, amountCent);
      if (res.changes === 0) {
        throw new Error('扣费失败：余额变动冲突或余额不足');
      }

      db.exec('COMMIT;');
      return {
        orderId,
        orderNo,
        memberId,
        deductedAmount: amountCent,
        balanceAfter: afterBalance,
        created_at: now
      };
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  },

  // --- 流水记录查询 ---
  getLedgerRecords({ memberId, type, startDate, endDate, limit = 50, offset = 0 } = {}) {
    let sql = `
      SELECT l.*, m.name as member_name, m.phone as member_phone
      FROM ledger_records l
      JOIN members m ON l.member_id = m.id
      WHERE 1=1
    `;
    const params = [];
    if (memberId) {
      sql += ' AND l.member_id = ?';
      params.push(memberId);
    }
    if (type) {
      sql += ' AND l.type = ?';
      params.push(type);
    }
    if (startDate) {
      sql += ' AND l.created_at >= ?';
      params.push(startDate);
    }
    if (endDate) {
      sql += ' AND l.created_at <= ?';
      params.push(endDate);
    }
    sql += ' ORDER BY l.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = db.prepare(sql);
    return stmt.all(...params);
  },

  // --- 营业数据总览与看板 ---
  getDashboardSummary() {
    // 统计总会员数、当前沉淀总额度
    const totalMemberStmt = db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(balance), 0) as total_balance FROM members');
    const { count: memberCount, total_balance: totalBalance } = totalMemberStmt.get();

    // 今日日期起始点 (本地时区简易计算)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStart = today.toISOString();

    // 今日充值统计
    const todayRechargeStmt = db.prepare(`
      SELECT COALESCE(SUM(actual_pay), 0) as actual_sum, COALESCE(SUM(total_credit), 0) as credit_sum, COUNT(*) as count
      FROM recharge_orders
      WHERE created_at >= ?
    `);
    const todayRecharge = todayRechargeStmt.get(todayStart);

    // 今日消费扣款统计
    const todayConsumeStmt = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as amount_sum, COUNT(*) as count
      FROM consume_orders
      WHERE created_at >= ?
    `);
    const todayConsume = todayConsumeStmt.get(todayStart);

    // 历史总充值与总消费
    const totalRechargeStmt = db.prepare('SELECT COALESCE(SUM(total_recharge), 0) as total, COALESCE(SUM(total_consume), 0) as total_c FROM members');
    const historyTotals = totalRechargeStmt.get();

    return {
      memberCount,
      totalBalance,               // 当前所有会员可用余额总和（分）
      historyTotalRecharge: historyTotals.total,
      historyTotalConsume: historyTotals.total_c,
      today: {
        rechargeCount: todayRecharge.count,
        rechargeActualPay: todayRecharge.actual_sum,   // 今日实际收款真实现金流
        rechargeCreditTotal: todayRecharge.credit_sum, // 今日入账额度
        consumeCount: todayConsume.count,
        consumeAmount: todayConsume.amount_sum         // 今日核销消费额度
      }
    };
  }
};
