import * as XLSX from 'xlsx';

export const IMPORT_LIMITS = Object.freeze({ bytes: 10 * 1024 * 1024, rows: 10005, columns: 128, cells: 500000, expandedBytes: 64 * 1024 * 1024 });

// Check ZIP directory sizes before XLSX can inflate compressed worksheets.
function checkZipBudget(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  if (bytes.length < 22 || view.getUint32(0, true) !== 0x04034b50) return;
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  if (end < 0) throw new Error('Excel 压缩文件目录无效');
  const entries = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true), expanded = 0;
  if (entries > 2048 || entries === 0xffff || offset + size > end) throw new Error('Excel 压缩文件超出解析限制');
  const directoryEnd = offset + size;
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50) throw new Error('Excel 压缩文件目录无效');
    expanded += view.getUint32(offset + 24, true);
    if (expanded > IMPORT_LIMITS.expandedBytes) throw new Error('Excel 解压数据过大，请分批导入');
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    if (offset > directoryEnd) throw new Error('Excel 压缩文件目录无效');
  }
}

export function parseImportBuffer(buffer, isCsv) {
  if (buffer.byteLength > IMPORT_LIMITS.bytes) throw new Error('导入文件过大，最大支持 10MB');
  const options = { sheetRows: IMPORT_LIMITS.rows + 1, sheets: 0 };
  let workbook;
  if (isCsv) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { text = new TextDecoder('gbk').decode(buffer); }
    workbook = XLSX.read(text, { ...options, type: 'string', raw: true });
  } else {
    checkZipBudget(buffer);
    workbook = XLSX.read(buffer, { ...options, type: 'array' });
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('文件中未找到任何工作表数据');
  const ref = sheet['!fullref'] || sheet['!ref'];
  if (!ref) throw new Error('导入表格中没有有效的数据行');
  if (!/^[A-Z]{1,3}[1-9]\d{0,6}(?::[A-Z]{1,3}[1-9]\d{0,6})?$/.test(ref)) throw new Error('工作表范围无效');
  const range = XLSX.utils.decode_range(ref);
  const rows = range.e.r + 1, columns = range.e.c + 1;
  if (range.s.r > range.e.r || range.s.c > range.e.c || columns > IMPORT_LIMITS.columns || rows * columns > IMPORT_LIMITS.cells) throw new Error('工作表范围过大，最多 128 列和 500,000 个单元格，请缩小范围后导入');
  if (rows > IMPORT_LIMITS.rows) throw new Error('单次导入最多支持 10,000 条记录，请分批导入');
  // Use raw cell values so display formats cannot round invalid money into validity.
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  if (rawRows.length < 2) throw new Error('导入表格中没有有效的数据行');
  return rawRows;
}
