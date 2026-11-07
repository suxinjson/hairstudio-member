import * as XLSX from 'xlsx';
import { checkZipBudget } from './zip-budget.js';

export const IMPORT_LIMITS = Object.freeze({ bytes: 10 * 1024 * 1024, rows: 10005, columns: 128, cells: 500000,
  expandedBytes: 64 * 1024 * 1024, cellText: 4096, resultBytes: 10 * 1024 * 1024 });
const textEncoder = new TextEncoder();

function cellSize(value) {
  if (value == null) return 16;
  if (typeof value === 'string') {
    if (value.length > IMPORT_LIMITS.cellText) throw new Error('单元格文本过长，最多 4,096 个字符，请缩短后导入');
    // Account for both UTF-8 and UTF-16, plus serialization/array overhead.
    return 16 + Math.max(value.length * 2, textEncoder.encode(value).byteLength);
  }
  if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return 16;
  throw new Error('表格单元格格式无效');
}
function checkResultSize(size) {
  if (size > IMPORT_LIMITS.resultBytes) throw new Error('表格展开数据过大，最多 10 MiB，请减少长文本或分批导入');
}

export function assertImportRowsBudget(rows) {
  if (!Array.isArray(rows) || rows.length > IMPORT_LIMITS.rows) throw new Error('表格数据行数无效');
  let cells = 0, size = rows.length * 32;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length > IMPORT_LIMITS.columns) throw new Error('表格数据列数无效');
    cells += row.length;
    if (cells > IMPORT_LIMITS.cells) throw new Error('表格单元格数量过多');
    for (const value of row) { size += cellSize(value); checkResultSize(size); }
  }
  return rows;
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
    checkZipBudget(buffer, IMPORT_LIMITS.expandedBytes);
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
  // sharedStrings may be small in the ZIP but large when repeated in a Worker
  // message. Check actual cell references before materializing that message.
  let size = rows * 32 + rows * columns * 16, count = 0;
  checkResultSize(size);
  for (const address in sheet) {
    if (address.startsWith('!')) continue;
    if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address)) throw new Error('工作表单元格地址无效');
    const cell = XLSX.utils.decode_cell(address);
    if (++count > IMPORT_LIMITS.cells || cell.r >= IMPORT_LIMITS.rows || cell.c >= IMPORT_LIMITS.columns) throw new Error('工作表范围过大，请分批导入');
    size += cellSize(sheet[address]?.v) - 16; checkResultSize(size);
  }
  // Preserve physical row/column numbers, including leading empty rows. Use raw
  // values so display formats cannot round invalid money into validity.
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', range: { s: { r: 0, c: 0 }, e: range.e } });
  if (rawRows.length < 2) throw new Error('导入表格中没有有效的数据行');
  return assertImportRowsBudget(rawRows);
}
