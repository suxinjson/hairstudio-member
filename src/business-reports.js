// Reports use the complete ledger snapshot, independently of member/transaction searches.
// Match getDashboard(): reversed originals and reversal entries are not effective sales.
export function localDateKey(value) {
  if (value === undefined || value === null || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function parseDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return localDateKey(date) === value ? date : null;
}

export function reportDateRange(period = 'month', now = new Date()) {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  if (period === 'yesterday') { start.setDate(start.getDate() - 1); end.setDate(end.getDate() - 1); }
  if (period === 'week') start.setDate(start.getDate() - 6);
  if (period === 'month') start.setDate(1);
  if (period === 'last30') start.setDate(start.getDate() - 29);
  return { startDate: localDateKey(start), endDate: localDateKey(end) };
}

export function buildBusinessReport({ ledgers = [], members = [], startDate, endDate }) {
  const start = parseDateKey(startDate), end = parseDateKey(endDate);
  if (!start || !end) throw new Error('请选择完整、有效的起止日期');
  if (start > end) throw new Error('开始日期不能晚于结束日期');
  const daily = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    if (daily.length >= 366) throw new Error('单次最多查看 366 天，请缩小统计范围');
    const date = localDateKey(cursor);
    daily.push({ date, label: date.slice(5).replace('-', '/'), rechargeCredit: 0, consumeAmount: 0, rechargeCount: 0, consumeCount: 0 });
  }
  const days = new Map(daily.map(day => [day.date, day]));
  const reversedIds = new Set(ledgers.filter(item => item.type === 'REFUND')
    .map(item => item.originalLedgerId || /原单号:([^\s()]+)/.exec(item.remark || '')?.[1]).filter(Boolean));
  const activeMembers = members.filter(member => !member.isArchived);
  const memberMap = new Map(activeMembers.map(member => [member.id, member]));
  const ranking = new Map();
  const summary = { rechargeCredit: 0, consumeAmount: 0, rechargeCount: 0, consumeCount: 0,
    reversalCount: 0, reversedOriginalCount: 0, balanceChange: 0, consumeMembers: 0, averageConsume: 0,
    newActiveMembers: activeMembers.filter(member => days.has(localDateKey(member.created_at))).length };
  for (const item of ledgers) {
    const day = days.get(localDateKey(item.created_at));
    if (!day) continue;
    summary.balanceChange += item.changeAmount;
    if (item.type === 'REFUND') { summary.reversalCount++; continue; }
    if (item.isRefunded || reversedIds.has(item.id)) { summary.reversedOriginalCount++; continue; }
    if (item.type === 'RECHARGE') {
      day.rechargeCredit += item.changeAmount; day.rechargeCount++;
      summary.rechargeCredit += item.changeAmount; summary.rechargeCount++;
    } else if (item.type === 'CONSUME') {
      const amount = Math.abs(item.changeAmount);
      day.consumeAmount += amount; day.consumeCount++;
      summary.consumeAmount += amount; summary.consumeCount++;
      const member = ranking.get(item.memberId) || { id: item.memberId,
        name: memberMap.get(item.memberId)?.name || item.memberName || '已注销会员', amount: 0, count: 0 };
      member.amount += amount; member.count++;
      ranking.set(item.memberId, member);
    }
  }
  summary.consumeMembers = ranking.size;
  summary.averageConsume = summary.consumeCount ? Math.round(summary.consumeAmount / summary.consumeCount) : 0;
  const balances = { memberCount: activeMembers.length, credit: 0, debt: 0, debtCount: 0, zeroCount: 0, lowCount: 0, fundedCount: 0 };
  for (const member of activeMembers) {
    if (member.balance < 0) { balances.debt -= member.balance; balances.debtCount++; }
    else if (member.balance === 0) balances.zeroCount++;
    else {
      balances.credit += member.balance;
      if (member.balance <= 5000) balances.lowCount++;
      else balances.fundedCount++;
    }
  }
  // Long ranges use calendar months so axis labels remain readable on a phone.
  let trend = daily;
  if (daily.length > 31) {
    const months = new Map();
    for (const day of daily) {
      const key = day.date.slice(0, 7);
      const month = months.get(key) || { date: key, label: key.replace('-', '/'), rechargeCredit: 0, consumeAmount: 0 };
      month.rechargeCredit += day.rechargeCredit; month.consumeAmount += day.consumeAmount;
      months.set(key, month);
    }
    trend = [...months.values()];
  }
  return { startDate, endDate, summary, daily, trend, trendUnit: daily.length > 31 ? '月' : '日', balances,
    ranking: [...ranking.values()].sort((a, b) => b.amount - a.amount || b.count - a.count || a.id.localeCompare(b.id)).slice(0, 10) };
}
