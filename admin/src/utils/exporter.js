import * as XLSX from 'xlsx';
import { sanitizeCellValue } from './importer.js';

/**
 * 导出会员列表为 Excel
 */
export function exportMembersToExcel(members, filename = '会员档案明细') {
  const exportData = members.map(m => {
    return {
      '会员姓名': sanitizeCellValue(m.name),
      '手机号码': sanitizeCellValue(m.phone),
      '卡内本金余额(元)': ((m.balance || 0) / 100).toFixed(2),
      '累计欠款(元)': m.balance < 0 ? ((Math.abs(m.balance)) / 100).toFixed(2) : '0.00',
      '会员标签': sanitizeCellValue(m.tags?.join('、') || m.tag || '普通会员'),
      '备注信息': sanitizeCellValue(m.remark || ''),
      '建卡时间': m.created_at ? new Date(m.created_at).toLocaleString('zh-CN') : '—',
      '状态': m.isArchived ? '已归档' : m.balance < 0 ? '欠款' : '正常'
    };
  });

  const ws = XLSX.utils.json_to_sheet(exportData);
  ws['!cols'] = [
    { wch: 14 },
    { wch: 16 },
    { wch: 16 },
    { wch: 14 },
    { wch: 16 },
    { wch: 28 },
    { wch: 20 },
    { wch: 10 }
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '会员档案');
  const dateStr = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `${filename}_${dateStr}.xlsx`);
}

/**
 * 导出财务流水账单为 Excel
 */
export function exportLedgersToExcel(ledgers, filename = '财务流水对账单') {
  const exportData = ledgers.map(l => {
    let typeName = '消费扣款';
    if (l.type === 'RECHARGE') typeName = '充值入账';
    if (l.type === 'REFUND') typeName = '撤销冲正';

    return {
      '流水单号': sanitizeCellValue(l.id),
      '交易时间': l.created_at ? new Date(l.created_at).toLocaleString('zh-CN') : '—',
      '会员姓名': sanitizeCellValue(l.memberName || '散客'),
      '联系电话': sanitizeCellValue(l.memberPhone || '—'),
      '业务类型': typeName,
      '变动金额(元)': ((l.changeAmount || 0) / 100).toFixed(2),
      '变动后余额(元)': ((l.balanceAfter || 0) / 100).toFixed(2),
      '项目明细/备注': sanitizeCellValue(l.remark || '无'),
      '冲正状态': l.isRefunded ? '已冲正撤销' : '正常'
    };
  });

  const ws = XLSX.utils.json_to_sheet(exportData);
  ws['!cols'] = [
    { wch: 24 },
    { wch: 20 },
    { wch: 14 },
    { wch: 16 },
    { wch: 14 },
    { wch: 14 },
    { wch: 16 },
    { wch: 28 },
    { wch: 12 }
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '流水对账明细');
  const dateStr = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `${filename}_${dateStr}.xlsx`);
}

/**
 * 导出系统安全审计日志
 */
export function exportAuditLogsToExcel(logs, filename = '系统安全审计日志') {
  const exportData = logs.map(l => {
    return {
      '日志编号': l.id,
      '记录时间': l.received_at ? new Date(l.received_at).toLocaleString('zh-CN') : '—',
      '操作人': sanitizeCellValue(l.display_name || '系统'),
      '事件类型': sanitizeCellValue(l.event || '—'),
      '客户端设备': sanitizeCellValue(l.device_id || '—'),
      '详情快照': JSON.stringify(l.details || {})
    };
  });

  const ws = XLSX.utils.json_to_sheet(exportData);
  ws['!cols'] = [
    { wch: 12 },
    { wch: 20 },
    { wch: 16 },
    { wch: 22 },
    { wch: 28 },
    { wch: 45 }
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '审计日志');
  const dateStr = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `${filename}_${dateStr}.xlsx`);
}
