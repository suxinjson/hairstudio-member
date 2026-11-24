import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import { resolve, relative, isAbsolute, sep, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { parseCents } from '../src/ledger-domain.js';
import { normalizeOpeningInput, phoneIdentity } from '../src/relational-contract.js';
import { openingPayload } from '../src/relational-opening-contract.js';

const digest = value => createHash('sha256').update(value).digest('hex');
export function yuanToCents(value) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(value)) throw new Error('元金额须为精确十进制文本，最多两位小数');
  const negative = value.startsWith('-'), [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return parseCents(String((negative ? -1n : 1n) * (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))))).toString();
}
function legacyCents(value) {
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) throw new Error('旧 JSON 余额必须是安全整数分，大整数须使用文本'); value = String(value); }
  return parseCents(value).toString();
}
export function buildOpeningProjection(raw, { format = 'json-cents', expectedCount = 91, batchId } = {}) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  if (bytes.length > 32 * 1024 * 1024) throw new Error('源文件超过 32 MiB');
  if (!isUtf8(bytes)) throw new Error('源文件必须是有效的 UTF-8 编码');
  const sourceDigest = digest(bytes), content = bytes.toString('utf8').replace(/^\uFEFF/, '');
  let rows;
  if (format === 'json-cents') {
    let parsed; try { parsed = JSON.parse(content); } catch { throw new Error('源 JSON 格式无效，请在受控位置修复原文件后再预检'); }
    rows = parsed?.data?.members ?? parsed?.members;
    if (!Array.isArray(rows)) throw new Error('旧 JSON 中不存在 members 数组');
  } else if (format === 'csv-yuan') {
    try { rows = parse(content, { columns: true, bom: true, skip_empty_lines: true, relax_column_count: false, max_record_size: 65536 }); }
    catch { throw new Error('CSV 解析失败，请检查编码、引号和列数'); }
    if (!rows.length || !['name', 'balance_yuan'].every(header => Object.hasOwn(rows[0], header))) throw new Error('CSV 必须有 name,balance_yuan 表头，可另有 id,phone,notes,tags');
  } else throw new Error('格式只支持 json-cents 或 csv-yuan');
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 20000 || rows.length !== expectedCount) throw new Error('源记录数量须与确认数量完全一致，禁止截断或补造会员');
  const generatedIdRows = [], archivedSourceRows = [], phoneCounts = new Map();
  const members = rows.map((row, index) => {
    try {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('会员行不是对象');
      let id = row.id;
      if (format === 'csv-yuan' && (id === undefined || id === '')) { id = 'import-' + sourceDigest.slice(0, 16) + '-' + (index + 1); generatedIdRows.push(index + 1); }
      const tagValues = row.tags == null || row.tags === '' ? [] : Array.isArray(row.tags) ? row.tags : format === 'csv-yuan' ? String(row.tags).split('|') : [row.tags];
      if (row.tag) tagValues.push(row.tag);
      const tags = [...new Set(tagValues.map(value => { if (typeof value !== 'string') throw new Error('标签必须为文本'); return value.trim(); }).filter(Boolean))].sort();
      const phone = row.phone ?? ''; if (typeof phone !== 'string') throw new Error('电话必须为文本，不能丢失前导零');
      const normalizedPhone = phoneIdentity(phone); if (normalizedPhone) phoneCounts.set(normalizedPhone, (phoneCounts.get(normalizedPhone) ?? 0) + 1);
      if (format === 'json-cents' && row.isArchived !== undefined && typeof row.isArchived !== 'boolean') throw new Error('旧归档标记必须为布尔值');
      if (row.isArchived === true || row.archived_at || row.archivedAt || row.deleted_at || row.isDeleted || row.archived === true) archivedSourceRows.push(index + 1);
      return { id, sourceMemberId: row.id || null, name: row.name, phone, notes: row.notes ?? '', tags,
        balanceCents: format === 'csv-yuan' ? yuanToCents(row.balance_yuan) : legacyCents(Object.hasOwn(row, 'balanceCents') ? row.balanceCents : row.balance) };
    } catch (error) { throw new Error('第 ' + (index + 1) + ' 行：' + error.message); }
  });
  const batch = normalizeOpeningInput({ batchId: batchId ?? 'opening-' + sourceDigest.slice(0, 32), sourceDigest, expectedCount, members });
  const payloadDigest = digest(openingPayload(batch));
  return { projection: { batchId: batch.batchId, sourceDigest, expectedCount, members: batch.rows },
    summary: { sourceDigest, payloadDigest, memberCount: batch.rows.length, netBalanceCents: batch.netBalanceCents,
      positiveBalanceCents: batch.positiveBalanceCents, negativeBalanceCents: batch.negativeBalanceCents,
      zeroBalanceCount: batch.zeroBalanceCount, negativeBalanceCount: batch.negativeBalanceCount,
      duplicatePhoneGroups: [...phoneCounts.values()].filter(count => count > 1).length, generatedIdRows, archivedSourceRows } };
}
async function main(args) {
  const options = {}; for (let i = 0; i < args.length; i += 2) {
    if (!['--source', '--format', '--expected-count', '--batch-id', '--out', '--reviewed-source-digest', '--reviewed-payload-digest', '--archived-review'].includes(args[i]) || args[i + 1] === undefined || Object.hasOwn(options, args[i])) throw new Error('参数无效或重复');
    options[args[i]] = args[i + 1];
  }
  if (!options['--source']) throw new Error('用法：--source <外部备份路径> [--format json-cents|csv-yuan] [--expected-count 91]；默认只读预检，不输出会员明细');
  const { projection, summary } = buildOpeningProjection(await readFile(resolve(options['--source'])), { format: options['--format'], expectedCount: options['--expected-count'] === undefined ? 91 : Number(options['--expected-count']), batchId: options['--batch-id'] });
  if (options['--out']) {
    const requested = resolve(options['--out']), parent = await realpath(dirname(requested)), target = join(parent, basename(requested));
    const repository = await realpath(fileURLToPath(new URL('../', import.meta.url))), inside = relative(repository, target);
    if (!inside || !isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep)) throw new Error('会员候选清单必须写入仓库之外的受控位置');
    if (summary.archivedSourceRows.length || options['--archived-review']) {
      if (!options['--archived-review']) throw new Error('源中有归档/删除标记，请先完成逐行去向核对并提供确认清单');
      let review;
      try {
        const path = await realpath(resolve(options['--archived-review'])), inside = relative(repository, path);
        if (!inside || !isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep)) throw new Error();
        const bytes = await readFile(path); if (bytes.length > 64 * 1024 || !isUtf8(bytes)) throw new Error();
        review = JSON.parse(bytes.toString('utf8'));
      } catch { throw new Error('归档去向确认清单须为仓库外的有效 JSON 文件'); }
      const expectedIds = summary.archivedSourceRows.map(row => projection.members[row - 1].id).sort();
      if (review?.reviewedSourceDigest !== summary.sourceDigest || !Array.isArray(review.reactivateIds) || review.reactivateIds.some(id => typeof id !== 'string') ||
          JSON.stringify([...review.reactivateIds].sort()) !== JSON.stringify(expectedIds)) throw new Error('归档去向确认清单须标记同一来源的全部归档编号，不得遗漏或增加');
    }
    if (options['--reviewed-source-digest'] !== summary.sourceDigest || options['--reviewed-payload-digest'] !== summary.payloadDigest) throw new Error('生成候选文件前须传入已核对的 source/payload 两份摘要');
    await writeFile(target, JSON.stringify(projection, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
  // Deliberately contains no names, phone numbers, notes or member rows.
  console.log(JSON.stringify({ ...summary, wroteProjection: Boolean(options['--out']), databaseWrites: 0 }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
