import express from 'express';
import cors from 'cors';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dbService } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// 获取局域网 IP 地址，便于手机端扫码/输入访问
export function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// 1. 看板数据
app.get('/api/dashboard', (req, res) => {
  try {
    const summary = dbService.getDashboardSummary();
    res.json({ code: 0, data: summary });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// 2. 会员列表与搜索
app.get('/api/members', (req, res) => {
  try {
    const { query, limit = 50, offset = 0 } = req.query;
    const members = dbService.getMembers({ query, limit: Number(limit), offset: Number(offset) });
    res.json({ code: 0, data: members });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// 3. 新建会员
app.post('/api/members', (req, res) => {
  try {
    const { name, phone, initialBalance, notes } = req.body;
    const member = dbService.createMember({ name, phone, initialBalance, notes });
    res.json({ code: 0, data: member, message: '会员创建成功' });
  } catch (err) {
    res.status(400).json({ code: 400, message: err.message });
  }
});

// 4. 获取会员详情 (附带最近50条流水)
app.get('/api/members/:id', (req, res) => {
  try {
    const member = dbService.getMemberById(req.params.id);
    if (!member) {
      return res.status(404).json({ code: 404, message: '会员未找到' });
    }
    const ledgers = dbService.getLedgerRecords({ memberId: member.id, limit: 50 });
    res.json({ code: 0, data: { ...member, ledgers } });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// 5. 修改会员信息
app.put('/api/members/:id', (req, res) => {
  try {
    const updated = dbService.updateMember(req.params.id, req.body);
    res.json({ code: 0, data: updated, message: '更新成功' });
  } catch (err) {
    res.status(400).json({ code: 400, message: err.message });
  }
});

// 6. 会员储值充值
app.post('/api/members/:id/recharge', (req, res) => {
  try {
    const { actualPay, giftAmount, payMethod, operator, remark } = req.body;
    const result = dbService.recharge({
      memberId: req.params.id,
      actualPay,
      giftAmount,
      payMethod,
      operator,
      remark
    });
    res.json({ code: 0, data: result, message: '充值成功' });
  } catch (err) {
    res.status(400).json({ code: 400, message: err.message });
  }
});

// 7. 会员消费扣款
app.post('/api/members/:id/consume', (req, res) => {
  try {
    const { amount, itemsSummary, operator, remark } = req.body;
    const result = dbService.consume({
      memberId: req.params.id,
      amount,
      itemsSummary,
      operator,
      remark
    });
    res.json({ code: 0, data: result, message: '扣款成功' });
  } catch (err) {
    res.status(400).json({ code: 400, message: err.message });
  }
});

// 8. 账本流水明细查询 (支持多条件组合筛选)
app.get('/api/ledgers', (req, res) => {
  try {
    const { memberId, type, startDate, endDate, limit = 100, offset = 0 } = req.query;
    const records = dbService.getLedgerRecords({
      memberId,
      type,
      startDate,
      endDate,
      limit: Number(limit),
      offset: Number(offset)
    });
    res.json({ code: 0, data: records });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// 9. 获取服务器网络地址信息
app.get('/api/system/network', (req, res) => {
  const localIp = getLocalIP();
  res.json({
    code: 0,
    data: {
      localIp,
      port: PORT,
      mobileUrl: `http://${localIp}:${PORT}`
    }
  });
});

// 托管前端静态资源 (如果生产构建存在)
const distPath = path.resolve(__dirname, '../dist');
app.use(express.static(distPath));

// 移动端单页路由重定向
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const indexPath = path.join(distPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><title>会员额度管理系统</title></head>
        <body style="font-family: sans-serif; padding: 20px; text-align: center;">
          <h2>会员额度管理服务已就绪</h2>
          <p>后端 API 正常运行，前端正在开发或尚未构建。</p>
          <p>手机端访问地址: <code>http://${getLocalIP()}:${PORT}</code></p>
        </body>
        </html>
      `);
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIP();
  console.log(`\n======================================================`);
  console.log(`✨ 会员额度管理系统服务已启动:`);
  console.log(`💻 本机电脑访问: http://localhost:${PORT}`);
  console.log(`📱 手机端访问:   http://${localIp}:${PORT}`);
  console.log(`======================================================\n`);
});
