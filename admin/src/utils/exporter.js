import * as XLSX from 'xlsx';

export function sanitizeCellValue(val) {
  if (typeof val !== 'string') return val;
  const raw = String(val);
  // 若包含前导制表符/回车，或首字符为危险计算符号，在前面加单引号转义为纯文本，防止在 Office 中触发公式执行
  if (/^[\t\r]/.test(raw) || /^[=+\-@]/.test(raw.trim())) {
    return "'" + raw;
  }
  return raw.trim();
}

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
