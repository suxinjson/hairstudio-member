import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBusinessReport, localDateKey, reportDateRange } from '../src/business-reports.js';

const time = (day, hour = 12) => new Date(2026, 10, day, hour).toISOString();
const transaction = (id, memberId, type, changeAmount, day, extra = {}) => ({ id, memberId, memberName: memberId,
  type, changeAmount, created_at: time(day), ...extra });
const range = { startDate: '2026-11-01', endDate: '2026-11-19' };

test('reports aggregate exact cents, gifted credits, unique customers and active member snapshots without mutations', () => {
  const members = [
    { id: 'a', name: '同名会员', balance: 2501, created_at: time(1) },
    { id: 'b', name: '同名会员', balance: -399, created_at: time(19) },
    { id: 'c', name: '零余额', balance: 0, created_at: '2026-10-01T00:00:00Z' },
    { id: 'd', name: '余额充足', balance: 5001, created_at: time(2) },
    { id: 'e', name: '已注销', balance: 0, created_at: time(2), isArchived: true },
    { id: 'f', name: '五十元边界', balance: 5000, created_at: time(2) }
  ];
  const ledgers = [transaction('1', 'a', 'RECHARGE', 11001, 1, { remark: '实充¥100.01，送¥10.00' }),
    transaction('2', 'a', 'CONSUME', -1001, 1), transaction('3', 'a', 'CONSUME', -1002, 2),
    transaction('4', 'b', 'CONSUME', -1000, 19), transaction('5', 'e', 'CONSUME', -300, 3)];
  const before = JSON.stringify({ members, ledgers });
  const report = buildBusinessReport({ ...range, ledgers, members });
  assert.deepEqual(report.summary, { rechargeCredit: 11001, consumeAmount: 3303, rechargeCount: 1, consumeCount: 4,
    reversalCount: 0, reversedOriginalCount: 0, balanceChange: 7698, consumeMembers: 3, averageConsume: 826, newActiveMembers: 4 });
  assert.deepEqual(report.balances, { memberCount: 5, credit: 12502, debt: 399, debtCount: 1, zeroCount: 1, lowCount: 2, fundedCount: 1 });
  assert.deepEqual(report.ranking.map(member => [member.id, member.amount]), [['a', 2003], ['b', 1000], ['e', 300]]);
  assert.equal(report.ranking[0].name, '同名会员');
  assert.equal(report.daily[0].rechargeCredit, 11001);
  assert.equal(report.daily[1].consumeAmount, 1002);
  assert.equal(JSON.stringify({ members, ledgers }), before);
});

test('cross-period reversals remove originals from effective totals while retaining the reversal-period balance change', () => {
  const ledgers = [transaction('consume', 'a', 'CONSUME', -3800, 1, { isRefunded: true }),
    transaction('reverse', 'a', 'REFUND', 3800, 19, { originalLedgerId: 'consume' }),
    transaction('recharge', 'a', 'RECHARGE', 11000, 1),
    transaction('reverse-recharge', 'a', 'REFUND', -11000, 19, { remark: '[撤销充值冲正] 原单号:recharge (错误入账)' })];
  const first = buildBusinessReport({ ledgers, startDate: '2026-11-01', endDate: '2026-11-01' });
  assert.equal(first.summary.consumeAmount, 0); assert.equal(first.summary.rechargeCredit, 0);
  assert.equal(first.summary.reversedOriginalCount, 2); assert.equal(first.summary.balanceChange, 7200);
  assert.equal(first.summary.reversalCount, 0); assert.deepEqual(first.ranking, []);
  const last = buildBusinessReport({ ledgers, startDate: '2026-11-19', endDate: '2026-11-19' });
  assert.equal(last.summary.balanceChange, -7200); assert.equal(last.summary.reversalCount, 2);
  const all = buildBusinessReport({ ledgers, ...range });
  assert.equal(all.summary.balanceChange, 0); assert.equal(all.summary.rechargeCount + all.summary.consumeCount, 0);
});

test('ranges include the whole first and last local days and fill dates without activity', () => {
  const ledgers = [transaction('before', 'a', 'RECHARGE', 100, 1), transaction('first', 'a', 'RECHARGE', 200, 2, { created_at: time(2, 0) }),
    transaction('last', 'a', 'CONSUME', -99, 4, { created_at: new Date(2026, 10, 4, 23, 59, 59, 999).toISOString() }),
    transaction('after', 'a', 'CONSUME', -100, 5), transaction('bad-date', 'a', 'RECHARGE', 999999, 2, { created_at: 'invalid' })];
  const report = buildBusinessReport({ ledgers, startDate: '2026-11-02', endDate: '2026-11-04' });
  assert.equal(report.summary.rechargeCredit, 200); assert.equal(report.summary.consumeAmount, 99);
  assert.equal(report.daily.length, 3); assert.equal(report.daily[1].consumeAmount + report.daily[1].rechargeCredit, 0);
});

test('preset periods use calendar dates across month, year and leap-day boundaries', () => {
  const now = new Date(2028, 2, 1, 16);
  assert.deepEqual(reportDateRange('today', now), { startDate: '2028-03-01', endDate: '2028-03-01' });
  assert.deepEqual(reportDateRange('yesterday', now), { startDate: '2028-02-29', endDate: '2028-02-29' });
  assert.deepEqual(reportDateRange('week', new Date(2026, 0, 2)), { startDate: '2025-12-27', endDate: '2026-01-02' });
  assert.deepEqual(reportDateRange('last30', now), { startDate: '2028-02-01', endDate: '2028-03-01' });
  assert.deepEqual(reportDateRange('month', new Date(2026, 10, 19)), range);
  assert.equal(localDateKey(undefined), ''); assert.equal(localDateKey(null), ''); assert.equal(localDateKey('invalid'), '');
});

test('long ranges aggregate chart points by month without changing daily data or totals', () => {
  const ledgers = [transaction('a', 'a', 'RECHARGE', 10001, 1), transaction('b', 'a', 'CONSUME', -2002, 19),
    transaction('c', 'a', 'CONSUME', -3333, 1, { created_at: new Date(2026, 11, 1).toISOString() })];
  const report = buildBusinessReport({ ledgers, startDate: '2026-11-01', endDate: '2026-12-15' });
  assert.equal(report.trendUnit, '月'); assert.equal(report.daily.length, 45);
  assert.deepEqual(report.trend.map(month => [month.date, month.rechargeCredit, month.consumeAmount]), [['2026-11', 10001, 2002], ['2026-12', 0, 3333]]);
});

test('invalid, reversed and excessively long ranges are rejected instead of silently showing a different period', () => {
  for (const startDate of ['', 'invalid', '2026-02-30', '2026-2-01']) {
    assert.throws(() => buildBusinessReport({ startDate, endDate: range.endDate }), /有效/);
  }
  assert.throws(() => buildBusinessReport({ startDate: '2026-11-20', endDate: range.endDate }), /不能晚于/);
  assert.throws(() => buildBusinessReport({ startDate: '2025-01-01', endDate: '2026-01-02' }), /366/);
  assert.equal(buildBusinessReport({ startDate: '2028-01-01', endDate: '2028-12-31' }).daily.length, 366);
});

test('empty reports have finite zero metrics, no fabricated new members, and a stable ten-member ranking', () => {
  const report = buildBusinessReport({ ...range, members: [{ id: 'undated', balance: 0 }] });
  assert.equal(report.summary.averageConsume, 0); assert.equal(report.summary.newActiveMembers, 0);
  assert.equal(report.daily.length, 19); assert.deepEqual(report.ranking, []);
  const ledgers = Array.from({ length: 12 }, (_, index) => transaction(String(index), String(index), 'CONSUME', -1000 - index, 1));
  const ranked = buildBusinessReport({ ledgers, ...range });
  assert.equal(ranked.ranking.length, 10); assert.equal(ranked.ranking[0].id, '11');
});
