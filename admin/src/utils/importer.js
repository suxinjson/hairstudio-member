import * as XLSX from 'xlsx';

// 防 CSV / Excel 公式注入 (Formula Injection) 安全清洗
export function sanitizeCellValue(val) {
  if (typeof val !== 'string') return val;
  const raw = String(val);
  // 若包含前导制表符/回车，或首字符为危险计算符号，在前面加单引号转义为纯文本，防止在 Office 中触发公式执行
  if (/^[\t\r]/.test(raw) || /^[=+\-@]/.test(raw.trim())) {
    return "'" + raw;
  }
  return raw.trim();
}

// 常见表头别名映射字典
const HEADER_ALIASES = {
  name: ['姓名', '会员姓名', '客户姓名', '顾客', '会员名', '顾客姓名', '会员', '名字', 'name'],
  phone: ['手机号', '联系电话', '手机', '电话', '手机号码', '联系方式', '移动电话', 'phone', 'mobile', 'tel'],
  balance: ['可用余额', '本金余额', '本金', '余额', '卡内余额', '当前余额', '储值余额', '账户余额', 'balance', 'amount'],
  gift: ['赠送金', '赠金余额', '赠送金额', '赠送', '赠金', '活动金', '奖励金', 'gift'],
  remark: ['备注', '说明', '剪发偏好', '喜好', '历史卡项', '客户备注', 'remark', 'notes', 'memo'],
  tag: ['会员等级', '标签', '会员类别', '客户分组', '分组', '类型', 'tag', 'tier']
};

/**
 * 自动猜测列映射
 */
export function guessColumnMapping(headers) {
  const mapping = {
    name: null,
    phone: null,
    balance: null,
    gift: null,
    remark: null,
    tag: null
  };

  headers.forEach((header, index) => {
    const cleanHeader = String(header || '').trim().toLowerCase();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (mapping[field] === null) {
        if (aliases.some(alias => cleanHeader.includes(alias.toLowerCase()))) {
          mapping[field] = index;
          break;
        }
      }
    }
  });

  return mapping;
}

/**
 * 解析上传的文件 (支持 .xlsx, .xls, .csv)
 */
export async function parseUploadedFile(file) {
  // 1. 安全限制检查：最大 10MB
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  if (file.size > MAX_FILE_SIZE) {
    throw new Error('导入文件过大，最大支持 10MB');
  }

  const name = file.name.toLowerCase();
  const isExcel = name.endsWith('.xlsx') || name.endsWith('.xls');
  const isCsv = name.endsWith('.csv');

  if (!isExcel && !isCsv) {
    throw new Error('仅支持上传 .xlsx、.xls 或 .csv 格式的文件');
  }

  // 2. 读取二进制数据
  const buffer = await file.arrayBuffer();
  let workbook;

  if (isCsv) {
    // 处理 CSV，考虑 UTF-8 / GBK 编码兼容性
    const decoder = new TextDecoder('utf-8');
    let text = decoder.decode(buffer);
    // 检测是否为乱码（如未带 BOM 的 GBK 导出），若出现过多替换字符可降级处理
    if (text.includes('')) {
      try {
        const gbkDecoder = new TextDecoder('gbk');
        text = gbkDecoder.decode(buffer);
      } catch {
        // 环境不支持 gbk 则维持 utf-8
      }
    }
    workbook = XLSX.read(text, { type: 'string' });
  } else {
    workbook = XLSX.read(buffer, { type: 'array' });
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('文件中未找到任何工作表数据');

  const sheet = workbook.Sheets[sheetName];
  // 转换为二维数组，保留原始字符串格式
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

  if (rawRows.length < 2) {
    throw new Error('导入表格中没有有效的数据行');
  }

  if (rawRows.length > 10001) {
    throw new Error('单次导入最多支持 10,000 条记录，请分批导入');
  }

  // 寻找表头行（寻找包含“姓名”或“手机”的最早一行）
  let headerIndex = -1;
  for (let i = 0; i < Math.min(rawRows.length, 5); i++) {
    const rowStr = rawRows[i].map(c => String(c).trim()).join(' ');
    if (HEADER_ALIASES.name.some(k => rowStr.includes(k)) || HEADER_ALIASES.phone.some(k => rowStr.includes(k))) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) {
    headerIndex = 0; // 默认第一行为表头
  }

  const headers = rawRows[headerIndex].map(c => sanitizeCellValue(String(c).trim()));
  const dataRows = rawRows.slice(headerIndex + 1).filter(row => row.some(cell => String(cell).trim() !== ''));

  const mapping = guessColumnMapping(headers);

  return {
    headers,
    dataRows,
    mapping,
    totalRows: dataRows.length
  };
}

/**
 * 校验与预检导入数据 (Dry-Run)
 * @param {Array} dataRows 二维数组数据
 * @param {Object} mapping 字段索引映射 { name: 0, phone: 1, balance: 2, ... }
 * @param {Array} existingMembers 现有系统会员列表
 * @param {Object} options 配置项 { conflictStrategy: 'skip' | 'merge_balance' | 'overwrite_profile' }
 */
export function validateImportBatch(dataRows, mapping, existingMembers = [], options = {}) {
  const strategy = options.conflictStrategy || 'skip';
  const existingMap = new Map();
  existingMembers.forEach(m => {
    if (m.phone) existingMap.set(String(m.phone).replace(/\s+/g, ''), m);
  });

  const filePhoneSet = new Set();
  const results = [];
  let validCount = 0;
  let conflictCount = 0;
  let invalidCount = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rowNum = i + 2; // 表头为第1行，数据从第2行算起

    const rawName = mapping.name !== null ? String(row[mapping.name] ?? '').trim() : '';
    const rawPhone = mapping.phone !== null ? String(row[mapping.phone] ?? '').trim() : '';
    const rawBalance = mapping.balance !== null ? String(row[mapping.balance] ?? '').trim() : '0';
    const rawGift = mapping.gift !== null ? String(row[mapping.gift] ?? '').trim() : '0';
    const rawRemark = mapping.remark !== null ? String(row[mapping.remark] ?? '').trim() : '';
    const rawTag = mapping.tag !== null ? String(row[mapping.tag] ?? '').trim() : '';

    const errors = [];

    // 1. 姓名校验
    if (!rawName) {
      errors.push('会员姓名不能为空');
    } else if (rawName.length > 32) {
      errors.push('会员姓名过长（最多32个字符）');
    }

    // 2. 手机号校验与清洗
    const cleanPhone = rawPhone.replace(/\D/g, '');
    if (!cleanPhone) {
      errors.push('联系电话不能为空');
    } else if (cleanPhone.length !== 11) {
      errors.push(`手机号格式不正确（须为11位，当前为${cleanPhone.length}位）`);
    }

    // 3. 余额金额校验
    let balanceCents = 0;
    if (rawBalance) {
      const num = Number(rawBalance.replace(/[¥,元]/g, '').trim());
      if (isNaN(num)) {
        errors.push(`本金余额金额无效: "${rawBalance}"`);
      } else {
        balanceCents = Math.round(num * 100);
      }
    }

    let giftCents = 0;
    if (rawGift) {
      const num = Number(rawGift.replace(/[¥,元]/g, '').trim());
      if (isNaN(num)) {
        errors.push(`赠送金金额无效: "${rawGift}"`);
      } else if (num < 0) {
        errors.push('赠送金不能为负数');
      } else {
        giftCents = Math.round(num * 100);
      }
    }

    // 4. 重复检测 (文件内部)
    let isFileDuplicate = false;
    if (cleanPhone) {
      if (filePhoneSet.has(cleanPhone)) {
        errors.push('文件中存在相同的手机号重复记录');
        isFileDuplicate = true;
      } else {
        filePhoneSet.add(cleanPhone);
      }
    }

    // 5. 与现有系统对比检测冲突
    let existingMember = null;
    let isConflict = false;
    if (cleanPhone && existingMap.has(cleanPhone)) {
      existingMember = existingMap.get(cleanPhone);
      isConflict = true;
    }

    if (errors.length > 0) {
      invalidCount++;
      results.push({
        rowNum,
        status: 'invalid',
        reason: errors.join('；'),
        data: {
          name: rawName,
          phone: cleanPhone || rawPhone,
          balanceCents,
          giftCents,
          remark: rawRemark,
          tag: rawTag
        }
      });
    } else if (isConflict) {
      conflictCount++;
      let strategyDesc = '';
      if (strategy === 'skip') strategyDesc = `跳过已有（保留当前余额 ¥${(existingMember.balance / 100).toFixed(2)}）`;
      if (strategy === 'merge_balance') strategyDesc = `累加余额（当前 ¥${(existingMember.balance / 100).toFixed(2)} + 导入 ¥${(balanceCents / 100).toFixed(2)}）`;
      if (strategy === 'overwrite_profile') strategyDesc = '覆盖更新姓名备注（保留原余额）';

      results.push({
        rowNum,
        status: 'conflict',
        reason: `系统已存在该会员 [${existingMember.name}] - ${strategyDesc}`,
        existingMember,
        data: {
          name: rawName,
          phone: cleanPhone,
          balanceCents,
          giftCents,
          remark: rawRemark,
          tag: rawTag
        }
      });
    } else {
      validCount++;
      results.push({
        rowNum,
        status: 'valid_new',
        reason: '正常新会员',
        data: {
          name: rawName,
          phone: cleanPhone,
          balanceCents,
          giftCents,
          remark: rawRemark,
          tag: rawTag
        }
      });
    }
  }

  return {
    total: dataRows.length,
    validCount,
    conflictCount,
    invalidCount,
    strategy,
    results
  };
}

/**
 * 生成并下载失败记录 Excel 表，方便店主一键修正后再导入
 */
export function downloadErrorReport(invalidItems, originalHeaders) {
  const exportData = invalidItems.map(item => {
    return {
      '原始行号': item.rowNum,
      '失败原因': item.reason,
      '会员姓名': item.data.name,
      '手机号码': item.data.phone,
      '本金余额': (item.data.balanceCents / 100).toFixed(2),
      '赠送金': (item.data.giftCents / 100).toFixed(2),
      '备注': item.data.remark,
      '标签': item.data.tag
    };
  });

  const ws = XLSX.utils.json_to_sheet(exportData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '导入异常明细');
  XLSX.writeFile(wb, `导入失败记录_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/**
 * 下载标准导入示例模板
 */
export function downloadImportTemplate() {
  const templateData = [
    {
      '会员姓名': '张晓丽',
      '手机号码': '13800001111',
      '可用余额': 500.00,
      '赠送金': 50.00,
      '会员标签': '常客VIP',
      '备注': '偏好总监剪发，发质偏干'
    },
    {
      '会员姓名': '王强',
      '手机号码': '13912345678',
      '可用余额': 200.00,
      '赠送金': 0.00,
      '会员标签': '男士理发',
      '备注': '两边剪短，无需打薄'
    },
    {
      '会员姓名': '李芳',
      '手机号码': '13788889999',
      '可用余额': 1200.00,
      '赠送金': 200.00,
      '会员标签': '染烫年卡',
      '备注': '对双氧奶气味较敏感'
    }
  ];

  const ws = XLSX.utils.json_to_sheet(templateData);
  // 列宽自适应设置
  ws['!cols'] = [
    { wch: 12 },
    { wch: 16 },
    { wch: 14 },
    { wch: 12 },
    { wch: 14 },
    { wch: 28 }
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '会员导入模板');
  XLSX.writeFile(wb, '梦飞空间会员批量导入模板.xlsx');
}
