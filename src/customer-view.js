// 消费记录决定来店顺序，编辑档案与充值不改变最近来店时间。
export function customerVisits(ledgers) {
  const visits = new Map();
  for (const ledger of ledgers) {
    if (ledger.type !== 'CONSUME' || ledger.isRefunded) continue;
    const timestamp = Date.parse(ledger.created_at);
    if (Number.isFinite(timestamp) && timestamp > (visits.get(ledger.memberId) ?? 0)) visits.set(ledger.memberId, timestamp);
  }
  return visits;
}

export function visibleCustomers(members, visits, filter, searching = false) {
  const filtered = members.filter(member => filter === 'debt' ? member.balance < 0
    : filter === 'low' ? member.balance >= 0 && member.balance <= 5000 : true);
  const sorted = [...filtered].sort((a, b) => (visits.get(b.id) ?? 0) - (visits.get(a.id) ?? 0)
    || Date.parse(b.created_at) - Date.parse(a.created_at) || a.id.localeCompare(b.id));
  return filter === 'recent' && !searching ? sorted.slice(0, 12) : sorted;
}
