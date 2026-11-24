import { canonicalJSON } from './canonical-json.js';
import { assertJsonBudget, byteLength } from './data-limits.js';
import { ENTITY_ID } from './relational-contract.js';
import { ledgerEpochOf } from './ledger-epoch.js';
import { backupTime } from './relational-backup-rows.js';

// Independent growth format. These are explicit resource ceilings, not claims
// that a phone can store 8 GiB or that the D1/D2 performance gates have passed.
export const ARCHIVE_LIMITS = Object.freeze({ frameBytes: 512 * 1024, chunkBytes: 1024 * 1024, rowsPerFrame: 200,
  tableRows: 4000000, totalRows: 20000000, totalBytes: 8 * 1024 * 1024 * 1024, frames: 1000000 });
const fail = (message, code = 'ARCHIVE_INVALID') => Object.assign(new Error(message), { status: 400, code });
function ensure(value, message, code) { if (!value) throw fail(message, code); }
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
export function archiveHeader(input, { engine, schemaVersion, storeId }) {
  ensure(shape(input, ['kind', 'format', 'formatVersion', 'engine', 'schemaVersion', 'storeId', 'ledgerEpoch', 'exportedAt']) &&
    input.kind === 'header' && input.format === 'member-relational-stream' && input.formatVersion === 1 &&
    input.engine === engine && input.schemaVersion === schemaVersion && input.storeId === storeId && ENTITY_ID.test(storeId) && backupTime(input.exportedAt), '流式备份格式、引擎或门店归属不匹配');
  ledgerEpochOf(input.ledgerEpoch); return { ...input };
}

export async function writeRelationalArchive({ header, tables, readTable, write, hash, validateRow, checkpoint = async () => {} }) {
  const names = Object.keys(tables), counts = Object.fromEntries(names.map(name => [name, 0]));
  let prior = await hash(canonicalJSON(header)), sequence = 0, totalRows = 0, totalBytes = 0, peakFrameBytes = 0;
  async function output(record) {
    const line = canonicalJSON(record) + '\n', size = byteLength(line);
    ensure(size <= ARCHIVE_LIMITS.frameBytes && totalBytes + size <= ARCHIVE_LIMITS.totalBytes, '流式备份超过文件或单块容量', 'ARCHIVE_CAPACITY');
    await checkpoint(); await write(line); totalBytes += size; peakFrameBytes = Math.max(peakFrameBytes, size);
  }
  async function frame(body) {
    ensure(++sequence <= ARCHIVE_LIMITS.frames, '流式备份分块数量超限', 'ARCHIVE_CAPACITY');
    const payload = { ...body, sequence, priorHash: prior }, checksum = await hash(canonicalJSON(payload));
    await output({ ...payload, hash: checksum }); prior = checksum;
  }
  await output(header);
  for (const table of names) {
    let rows = [], bytes = 1024;
    const flush = async () => { if (rows.length) { await frame({ kind: 'rows', table, rows }); rows = []; bytes = 1024; } };
    for await (const page of readTable(table)) {
      ensure(Array.isArray(page) && page.length <= 500, '数据库备份分页无界');
      for (const row of page) {
        validateRow(table, row, header.storeId);
        const values = tables[table].map(column => row[column]), rowBytes = byteLength(canonicalJSON(values)) + 1;
        ensure(rowBytes + 1024 <= ARCHIVE_LIMITS.frameBytes, '单行超出流式备份容量', 'ARCHIVE_CAPACITY');
        if (bytes + rowBytes > ARCHIVE_LIMITS.frameBytes || rows.length === ARCHIVE_LIMITS.rowsPerFrame) await flush();
        rows.push(values); bytes += rowBytes;
        ensure(++counts[table] <= ARCHIVE_LIMITS.tableRows && ++totalRows <= ARCHIVE_LIMITS.totalRows, '流式备份记录数量超限', 'ARCHIVE_CAPACITY');
      }
    }
    await flush(); await frame({ kind: 'tableEnd', table, rowCount: counts[table] });
  }
  await frame({ kind: 'end', tableCount: names.length, rowCount: totalRows });
  return { digest: prior, rowCounts: counts, rowCount: totalRows, byteLength: totalBytes, frameCount: sequence, peakFrameBytes };
}

// Input is a pull-based byte stream. At most one bounded UTF-8 line and one
// bounded frame are retained, independent of total book size. All inserts must
// remain in the caller's transaction until this function AND DB validation pass.
export async function readRelationalArchive({ chunks, tables, engine, schemaVersion, storeId, hash, validateRow,
  onHeader = async () => {}, onRows = async () => {}, checkpoint = async () => {} }) {
  const names = Object.keys(tables), counts = Object.fromEntries(names.map(name => [name, 0])), decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', pendingBytes = 0, header, prior, sequence = 0, tableIndex = 0, totalRows = 0, totalBytes = 0, ended = false, peakFrameBytes = 0;
  async function line(value) {
    ensure(value.length && !ended, '结束记录之后存在多余数据或空行');
    const size = byteLength(value) + 1; ensure(size <= ARCHIVE_LIMITS.frameBytes, '流式备份单块过大', 'ARCHIVE_CAPACITY');
    peakFrameBytes = Math.max(peakFrameBytes, size);
    let record; try { record = JSON.parse(value); } catch { throw fail('流式备份 JSON 分块损坏'); }
    assertJsonBudget(record, ARCHIVE_LIMITS.frameBytes, ARCHIVE_LIMITS.frameBytes);
    ensure(canonicalJSON(record) === value, '流式备份必须使用规范 JSON，不接受重复字段或隐式转换');
    if (!header) {
      header = archiveHeader(record, { engine, schemaVersion, storeId }); prior = await hash(value);
      await checkpoint(); await onHeader({ ...header }); return;
    }
    const keys = record.kind === 'rows' ? ['kind', 'sequence', 'priorHash', 'table', 'rows', 'hash'] : record.kind === 'tableEnd' ?
      ['kind', 'sequence', 'priorHash', 'table', 'rowCount', 'hash'] : record.kind === 'end' ? ['kind', 'sequence', 'priorHash', 'tableCount', 'rowCount', 'hash'] : [];
    ensure(shape(record, keys) && ++sequence <= ARCHIVE_LIMITS.frames && record.sequence === sequence && record.priorHash === prior && hex(record.hash), '流式备份分块序号、类型或摘要链无效');
    const { hash: checksum, ...payload } = record;
    ensure(await hash(canonicalJSON(payload)) === checksum, '流式备份分块摘要不匹配');
    if (record.kind === 'rows') {
      ensure(tableIndex < names.length && record.table === names[tableIndex] && Array.isArray(record.rows) && record.rows.length > 0 && record.rows.length <= ARCHIVE_LIMITS.rowsPerFrame, '流式备份关系表顺序或行数无效');
      const columns = tables[record.table], rows = record.rows.map(values => {
        ensure(Array.isArray(values) && values.length === columns.length, '流式备份关系列数不匹配');
        const row = Object.fromEntries(columns.map((column, index) => [column, values[index]])); validateRow(record.table, row, storeId); return row;
      });
      counts[record.table] += rows.length; totalRows += rows.length;
      ensure(counts[record.table] <= ARCHIVE_LIMITS.tableRows && totalRows <= ARCHIVE_LIMITS.totalRows, '流式备份记录数量超限', 'ARCHIVE_CAPACITY');
      await checkpoint(); await onRows(record.table, rows);
    } else if (record.kind === 'tableEnd') {
      ensure(tableIndex < names.length && record.table === names[tableIndex] && record.rowCount === counts[record.table], '流式备份关系表结束计数不匹配'); tableIndex++;
    } else {
      ensure(tableIndex === names.length && record.tableCount === names.length && record.rowCount === totalRows, '流式备份结束记录不完整'); ended = true;
    }
    prior = checksum;
  }
  async function decoded(text) {
    let at = 0, next;
    while ((next = text.indexOf('\n', at)) !== -1) {
      const part = text.slice(at, next); pending += part; pendingBytes += byteLength(part);
      ensure(pendingBytes + 1 <= ARCHIVE_LIMITS.frameBytes, '流式备份单块过大', 'ARCHIVE_CAPACITY');
      await line(pending); pending = ''; pendingBytes = 0; at = next + 1;
    }
    const rest = text.slice(at); pending += rest; pendingBytes += byteLength(rest);
    ensure(pendingBytes < ARCHIVE_LIMITS.frameBytes, '流式备份单块过大', 'ARCHIVE_CAPACITY');
  }
  for await (const chunk of chunks) {
    ensure(chunk instanceof Uint8Array && chunk.byteLength > 0 && chunk.byteLength <= ARCHIVE_LIMITS.chunkBytes, '流式备份输入须为有界 UTF-8 字节块');
    totalBytes += chunk.byteLength; ensure(totalBytes <= ARCHIVE_LIMITS.totalBytes, '流式备份文件超出容量', 'ARCHIVE_CAPACITY');
    let text; try { text = decoder.decode(chunk, { stream: true }); } catch { throw fail('流式备份包含无效 UTF-8'); } await decoded(text);
  }
  let last; try { last = decoder.decode(); } catch { throw fail('流式备份 UTF-8 尾部损坏'); } await decoded(last);
  ensure(header && ended && !pending.length, '流式备份缺少完整结束记录或已被截断', 'ARCHIVE_TRUNCATED');
  await checkpoint();
  return { header, digest: prior, rowCounts: counts, rowCount: totalRows, byteLength: totalBytes, frameCount: sequence, peakFrameBytes };
}
