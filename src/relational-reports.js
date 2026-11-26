import { boundedText } from './data-limits.js';
import { ledgerEpochOf } from './ledger-epoch.js';

function invalid(message) { return Object.assign(new Error(message), { status: 400, code: 'INVALID_INPUT' }); }
export function reportPeriod(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('报表条件须为对象');
  let { from, to } = input;
  function instant(value) {
    if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) throw invalid('报表时间须为含时区的 ISO 时间，精度不超过毫秒');
    const [year, month, day] = value.slice(0, 10).split('-').map(Number), date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || !Number.isFinite(Date.parse(value))) throw invalid('报表时间无效');
    const normalized = new Date(value);
    if (normalized.getUTCFullYear() < 1 || normalized.getUTCFullYear() > 9999) throw invalid('报表时间超出支持范围');
    return normalized.toISOString();
  }
  from = instant(from); to = instant(to);
  if (from >= to) throw invalid('报表开始时间须早于结束时间（左闭右开）');
  return { from, to };
}
export function reportLimit(value = 50) {
  if (!(typeof value === 'number' && Number.isInteger(value) || typeof value === 'string' && /^[1-9][0-9]{0,2}$/.test(value)) || Number(value) < 1 || Number(value) > 100) throw invalid('每页数量须为 1–100');
  return Number(value);
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function reportCursor(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value)); let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index], b = bytes[index + 1], c = bytes[index + 2];
    encoded += alphabet[a >> 2] + alphabet[(a & 3) << 4 | (b ?? 0) >> 4];
    if (b !== undefined) encoded += alphabet[(b & 15) << 2 | (c ?? 0) >> 6];
    if (c !== undefined) encoded += alphabet[c & 63];
  }
  return encoded;
}
export function readReportCursor(value, { kind, from, to }) {
  if (value === undefined || value === null || value === '') return null;
  try {
    if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error();
    const bytes = []; let bits = 0, buffer = 0;
    for (const char of value) { buffer = (buffer << 6 | alphabet.indexOf(char)) & 65535; bits += 6; if (bits >= 8) { bits -= 8; bytes.push(buffer >> bits & 255); } }
    const cursor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)));
    if (Object.keys(cursor).length !== 6 || cursor.kind !== kind || cursor.from !== from || cursor.to !== to || typeof cursor.name !== 'string' || typeof cursor.id !== 'string') throw new Error();
    ledgerEpochOf(cursor.ledgerEpoch);
    boundedText(cursor.name, 128, '报表分组'); boundedText(cursor.id, 128, '报表实体');
    if (reportCursor(cursor) !== value) throw new Error();
    return cursor;
  } catch { throw invalid('明细分页游标与查询不匹配'); }
}
export function reportBreakdownInput(input = {}) {
  const period = reportPeriod(input), kind = input.kind;
  if (!['payment', 'service'].includes(kind)) throw invalid('明细类型须为 payment 或 service');
  return { ...period, kind, limit: reportLimit(input.limit), cursor: readReportCursor(input.cursor, { ...period, kind }) };
}

export const REPORT_MONEY_FIELDS = Object.freeze(['actualPayCents', 'giftCents', 'consumptionCents', 'reversedActualPayCents', 'reversedGiftCents', 'reversedConsumptionCents', 'netChangeCents']);
export const REPORT_COUNT_FIELDS = Object.freeze(['rechargeCount', 'consumeCount', 'reversalCount', 'reversedRechargeCount', 'reversedConsumeCount', 'newActiveMemberCount']);
export function reportCount(value) {
  const integer = BigInt(value);
  if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < -BigInt(Number.MAX_SAFE_INTEGER)) throw Object.assign(new Error('报表计数超过安全范围'), { status: 413, code: 'REPORT_CAPACITY' });
  return Number(integer);
}
export function businessReportInput(input = {}) {
  const period = reportPeriod(input), raw = input.offsetMinutes === undefined ? 480 : input.offsetMinutes;
  if (!(typeof raw === 'number' && Number.isInteger(raw) || typeof raw === 'string' && /^-?(0|[1-9][0-9]{0,2})$/.test(raw)) || Math.abs(Number(raw)) > 840) throw invalid('报表时区须为 UTC 偏移分钟（-840～840）');
  const offsetMinutes = Number(raw), shift = offsetMinutes * 60000;
  const first = new Date(Date.parse(period.from) + shift), last = new Date(Date.parse(period.to) - 1 + shift);
  if (first.getUTCFullYear() < 1 || last.getUTCFullYear() > 9999) throw invalid('报表本地日期超出支持范围');
  const days = [], end = last.toISOString().slice(0, 10);
  first.setUTCHours(0, 0, 0, 0);
  for (;;) {
    const day = first.toISOString().slice(0, 10); days.push(day);
    if (days.length > 366) throw invalid('经营趋势单次最多 366 个日历日，请缩小范围');
    if (day === end) break;
    first.setUTCDate(first.getUTCDate() + 1);
  }
  return { ...period, offsetMinutes, days };
}
export function businessReportResult(input, { daily, balances, ranking, consumeMemberCount }) {
  const fields = [...REPORT_MONEY_FIELDS, ...REPORT_COUNT_FIELDS];
  const empty = () => Object.fromEntries(fields.map(key => [key, 0n]));
  const days = new Map(input.days.map(day => [day, { date: day, ...empty() }])), summary = empty();
  for (const row of daily) {
    const target = days.get(row.date);
    if (!target) throw new Error('报表分组超出请求日历范围');
    for (const key of fields) { const value = BigInt(row[key] ?? '0'); target[key] += value; summary[key] += value; }
  }
  function output(row) {
    const result = { ...(row.date ? { date: row.date } : {}) };
    for (const key of REPORT_MONEY_FIELDS) result[key] = String(row[key]);
    for (const key of REPORT_COUNT_FIELDS) result[key] = reportCount(row[key]);
    result.rechargeCreditCents = String(row.actualPayCents + row.giftCents);
    result.netRechargeCreditCents = String(row.actualPayCents + row.giftCents - row.reversedActualPayCents - row.reversedGiftCents);
    result.netActualPayCents = String(row.actualPayCents - row.reversedActualPayCents);
    result.netGiftCents = String(row.giftCents - row.reversedGiftCents);
    result.netConsumeCount = reportCount(row.consumeCount - row.reversedConsumeCount);
    result.netConsumptionCents = String(row.consumptionCents - row.reversedConsumptionCents);
    return result;
  }
  const months = new Map();
  for (const row of days.values()) {
    const month = row.date.slice(0, 7); if (!months.has(month)) months.set(month, { date: month, ...empty() });
    for (const key of fields) months.get(month)[key] += row[key];
  }
  return { from: input.from, to: input.to, offsetMinutes: input.offsetMinutes,
    summary: { ...output(summary), consumeMemberCount: reportCount(consumeMemberCount), averageConsumeCents: summary.consumeCount ? String((summary.consumptionCents + summary.consumeCount / 2n) / summary.consumeCount) : '0' },
    daily: [...days.values()].map(output), trend: [...(days.size > 31 ? months : days).values()].map(output), trendUnit: days.size > 31 ? 'month' : 'day', balances, ranking };
}
