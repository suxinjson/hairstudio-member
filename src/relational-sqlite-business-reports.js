import { businessReportInput, businessReportResult, reportCount } from './relational-reports.js';
import { SQLITE_AGGREGATE_BATCH as BATCH, SQLITE_AGGREGATE_PAGE as PAGE, sqliteSums as sums, addSqliteSums as add } from './relational-sqlite-aggregate.js';

const money = { actualPayCents: 'e.actual_pay_cents', giftCents: 'e.gift_cents', consumptionCents: "CASE WHEN e.kind='consume' THEN -e.delta_cents ELSE 0 END", reversedActualPayCents: 'COALESCE(o.actual_pay_cents,0)', reversedGiftCents: 'COALESCE(o.gift_cents,0)', reversedConsumptionCents: "CASE WHEN o.kind='consume' THEN -o.delta_cents ELSE 0 END", netChangeCents: 'e.delta_cents' };
const counters = { rechargeCount: "e.kind='recharge'", consumeCount: "e.kind='consume'", reversalCount: "e.kind='reversal'", reversedRechargeCount: "o.kind='recharge'", reversedConsumeCount: "o.kind='consume'" };
const joins = ' FROM ledger_entries e LEFT JOIN entry_confirmations c ON c.store_id=e.store_id AND c.entry_id=e.entry_id LEFT JOIN ledger_reversals r ON r.store_id=e.store_id AND r.reversal_entry_id=e.entry_id LEFT JOIN ledger_entries o ON o.store_id=r.store_id AND o.entry_id=r.original_entry_id';
const occurred = 'COALESCE(c.occurred_at,e.occurred_at)';
const periodWhere = ' WHERE e.store_id=? AND ' + occurred + '>=? AND ' + occurred + '<?';
export function sqliteBusinessReports({ all, one, storeId, localState }) {
  return async function business(input = {}) {
    const period = businessReportInput(input), { from, to, offsetMinutes } = period, params = [storeId, from, to];
    const daily = new Map(), moneyKeys = Object.keys(money), countKeys = Object.keys(counters);
    const projections = [...Object.entries(money).map(([key, expression]) => expression + ' AS ' + key), ...Object.entries(counters).map(([key, expression]) => 'CASE WHEN ' + expression + ' THEN 1 ELSE 0 END AS ' + key)];
    const movements = "SELECT strftime('%Y-%m-%d'," + occurred + ",? || ' minutes') AS date,(e.rowid-1)/" + BATCH + ' AS chunk,' + projections.join(',') + joins + periodWhere;
    let scan = null;
    for (;;) {
      const rows = await all('WITH movements AS (' + movements + ') SELECT date,chunk,' + sums(Object.fromEntries(moneyKeys.map(key => [key, key]))) + ',' + countKeys.map(key => 'SUM(' + key + ') AS ' + key).join(',') + ' FROM movements WHERE (? IS NULL OR date>? OR (date=? AND chunk>CAST(? AS INTEGER))) GROUP BY date,chunk ORDER BY date,chunk LIMIT ' + PAGE, [String(offsetMinutes), ...params, scan?.date ?? null, scan?.date ?? '', scan?.date ?? '', scan?.chunk ?? '-1']);
      for (const row of rows) { if (!daily.has(row.date)) daily.set(row.date, { date: row.date }); const values = daily.get(row.date); add(values, row, moneyKeys); for (const key of countKeys) values[key] = (values[key] ?? 0n) + BigInt(row[key]); scan = { date: row.date, chunk: String(row.chunk) }; }
      if (rows.length < PAGE) break;
    }
    const newMembers = await all("SELECT strftime('%Y-%m-%d',m.created_at,? || ' minutes') AS date,count(*) AS newActiveMemberCount FROM member_profiles m WHERE m.store_id=? AND m.archived_at IS NULL AND m.created_at>=? AND m.created_at<? AND NOT EXISTS(SELECT 1 FROM account_openings b WHERE b.store_id=m.store_id AND b.member_id=m.id) GROUP BY date ORDER BY date", [String(offsetMinutes), ...params]);
    const consumeMembers = await one("SELECT count(DISTINCT e.member_id) AS n FROM ledger_entries e LEFT JOIN entry_confirmations c ON c.store_id=e.store_id AND c.entry_id=e.entry_id WHERE e.store_id=? AND e.kind='consume' AND " + occurred + '>=? AND ' + occurred + '<?', params);
    const balanceFields = { storedCents: 'CASE WHEN a.balance_cents>0 THEN a.balance_cents ELSE 0 END', debtCents: 'CASE WHEN a.balance_cents<0 THEN a.balance_cents ELSE 0 END' }, balanceCounts = { memberCount: '1', debtCount: 'a.balance_cents<0', zeroCount: 'a.balance_cents=0', lowCount: 'a.balance_cents>0 AND a.balance_cents<=5000', fundedCount: 'a.balance_cents>5000' }, totals = {};
    let after = '-1';
    for (;;) {
      const rows = await all('SELECT (a.rowid-1)/' + BATCH + ' AS chunk,' + sums(balanceFields) + ',' + Object.entries(balanceCounts).map(([key, condition]) => 'SUM(CASE WHEN ' + condition + ' THEN 1 ELSE 0 END) AS ' + key).join(',') + ' FROM member_accounts a JOIN member_profiles m ON m.store_id=a.store_id AND m.id=a.member_id WHERE a.store_id=? AND m.archived_at IS NULL AND a.rowid>(CAST(? AS INTEGER)+1)*' + BATCH + ' GROUP BY chunk ORDER BY chunk LIMIT ' + PAGE, [storeId, after]);
      for (const row of rows) { add(totals, row, Object.keys(balanceFields)); for (const key of Object.keys(balanceCounts)) totals[key] = (totals[key] ?? 0n) + BigInt(row[key]); after = String(row.chunk); }
      if (rows.length < PAGE) break;
    }
    const balances = Object.fromEntries(Object.keys(balanceFields).map(key => [key, String(totals[key] ?? 0n)]));
    for (const key of Object.keys(balanceCounts)) balances[key] = reportCount(totals[key] ?? 0n);
    const ranking = await rank(params);
    return { ...businessReportResult(period, { daily: [...daily.values(), ...newMembers], balances, ranking, consumeMemberCount: consumeMembers.n }), localState: await localState() };
  };

  async function rank(params) {
    const movements = 'SELECT e.member_id,(e.rowid-1)/' + BATCH + " AS chunk,CASE WHEN e.kind='consume' THEN -e.delta_cents WHEN o.kind='consume' THEN o.delta_cents ELSE 0 END AS amount,CASE WHEN e.kind='consume' THEN 1 WHEN o.kind='consume' THEN -1 ELSE 0 END AS n" + joins + periodWhere + " AND (e.kind='consume' OR o.kind='consume')";
    const top = []; let scan = null, current = null;
    function finish() {
      if (!current || current.amount === 0n) return;
      top.push(current); top.sort((a, b) => a.amount !== b.amount ? a.amount > b.amount ? -1 : 1 : a.n !== b.n ? a.n > b.n ? -1 : 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0); if (top.length > 10) top.pop();
    }
    for (;;) {
      const rows = await all('WITH movements AS (' + movements + '),chunks AS(SELECT member_id,chunk,SUM(n) AS n,' + sums({ amount: 'amount' }) + ' FROM movements GROUP BY member_id,chunk) SELECT * FROM chunks WHERE (? IS NULL OR member_id>? OR (member_id=? AND chunk>CAST(? AS INTEGER))) ORDER BY member_id,chunk LIMIT ' + PAGE, [...params, scan?.id ?? null, scan?.id ?? '', scan?.id ?? '', scan?.chunk ?? '-1']);
      for (const row of rows) {
        if (current?.id !== row.member_id) { finish(); current = { id: row.member_id, amount: 0n, n: 0n }; }
        add(current, row, ['amount']); current.n += BigInt(row.n); scan = { id: row.member_id, chunk: String(row.chunk) };
      }
      if (rows.length < PAGE) break;
    }
    finish();
    const result = [];
    for (const row of top) { const member = await one('SELECT name FROM member_profiles WHERE store_id=? AND id=?', [storeId, row.id]); result.push({ memberId: row.id, name: member.name, netConsumptionCents: String(row.amount), netConsumeCount: reportCount(row.n) }); }
    return result;
  }
}
