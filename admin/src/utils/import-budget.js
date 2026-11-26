export const IMPORT_LIMITS = Object.freeze({ bytes: 10 * 1024 * 1024, rows: 10005, columns: 128, cells: 500000,
  expandedBytes: 64 * 1024 * 1024, cellText: 4096, resultBytes: 10 * 1024 * 1024 });
const textEncoder = new TextEncoder();

export function cellSize(value) {
  if (value == null) return 16;
  if (typeof value === 'string') {
    if (value.length > IMPORT_LIMITS.cellText) throw new Error('单元格文本过长，最多 4,096 个字符，请缩短后导入');
    // Account for both UTF-8 and UTF-16, plus serialization/array overhead.
    return 16 + Math.max(value.length * 2, textEncoder.encode(value).byteLength);
  }
  if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return 16;
  throw new Error('表格单元格格式无效');
}
export function checkResultSize(size) {
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

