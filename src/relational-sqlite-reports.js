import { reportPeriod, reportBreakdownInput, reportCursor } from './relational-reports.js';
import { SQLITE_AGGREGATE_BATCH as BATCH, SQLITE_AGGREGATE_PAGE as PAGE, sqliteSums as sums, addSqliteSums as add } from './relational-sqlite-aggregate.js';
import { sqliteBusinessReports } from './relational-sqlite-business-reports.js';
import { requireLedgerEpoch } from './ledger-epoch.js';

function count(value) { if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw Object.assign(new Error('报表计数超过安全范围'), { status: 413, code: 'REPORT_CAPACITY' }); return Number(value); }

export function sqliteReports({ all, one, storeId, mode }) {
  async function localState() {
    const book = await one('SELECT cursor,ledger_epoch FROM book_identity WHERE singleton=1');
    const row = await one("SELECT count(*) AS pending_count,COALESCE(sum(CASE WHEN status='conflict' THEN 1 ELSE 0 END),0) AS conflict_count FROM sync_outbox WHERE store_id=?", [storeId]);
    return { mode, ledgerEpoch: book.ledger_epoch, cursor: String(book.cursor), pendingCount: count(BigInt(row.pending_count)), conflictCount: count(BigInt(row.conflict_count)) };
  }
  async function summary(input) {
    const { from, to } = reportPeriod(input), amounts = {}, accountFields = { stored: 'CASE WHEN balance_cents>0 THEN balance_cents ELSE 0 END', debt: 'CASE WHEN balance_cents<0 THEN balance_cents ELSE 0 END' };
    let memberCount = 0n, after = '-1';
    for (;;) {
      const rows = await all('SELECT (rowid-1)/' + BATCH + ' AS chunk,count(*) AS n,' + sums(accountFields) + ' FROM member_accounts WHERE store_id=? AND rowid>(CAST(? AS INTEGER)+1)*' + BATCH + ' GROUP BY chunk ORDER BY chunk LIMIT ' + PAGE, [storeId, after]);
      for (const row of rows) { memberCount += BigInt(row.n); add(amounts, row, Object.keys(accountFields)); after = String(row.chunk); }
      if (rows.length < PAGE) break;
    }
    const periodFields = { netChange: 'e.delta_cents', actualPay: 'e.actual_pay_cents', gift: 'e.gift_cents', consumption: "CASE WHEN e.kind='consume' THEN -e.delta_cents ELSE 0 END", reversalDelta: "CASE WHEN e.kind='reversal' THEN e.delta_cents ELSE 0 END", reversedActualPay: 'COALESCE(o.actual_pay_cents,0)', reversedGift: 'COALESCE(o.gift_cents,0)', reversedConsumption: "CASE WHEN o.kind='consume' THEN -o.delta_cents ELSE 0 END" };
    let entryCount = 0n; after = '-1';
    for (;;) {
      const rows = await all('SELECT (e.rowid-1)/' + BATCH + ' AS chunk,count(*) AS n,' + sums(periodFields) + ' FROM ledger_entries e LEFT JOIN entry_confirmations c ON c.store_id=e.store_id AND c.entry_id=e.entry_id LEFT JOIN ledger_reversals r ON r.store_id=e.store_id AND r.reversal_entry_id=e.entry_id LEFT JOIN ledger_entries o ON o.store_id=r.store_id AND o.entry_id=r.original_entry_id WHERE e.store_id=? AND e.rowid>(CAST(? AS INTEGER)+1)*' + BATCH + ' AND COALESCE(c.occurred_at,e.occurred_at)>=? AND COALESCE(c.occurred_at,e.occurred_at)<? GROUP BY chunk ORDER BY chunk LIMIT ' + PAGE, [storeId, after, from, to]);
      for (const row of rows) { entryCount += BigInt(row.n); add(amounts, row, Object.keys(periodFields)); after = String(row.chunk); }
      if (rows.length < PAGE) break;
    }
    const result = { from, to, memberCount: count(memberCount), entryCount: count(entryCount), localState: await localState() };
    for (const name of [...Object.keys(accountFields), ...Object.keys(periodFields)]) result[name + 'Cents'] = String(amounts[name] ?? 0n);
    for (const name of ['ActualPay', 'Gift', 'Consumption']) result['net' + name + 'Cents'] = String((amounts[name[0].toLowerCase() + name.slice(1)] ?? 0n) - (amounts['reversed' + name] ?? 0n));
    return result;
  }
  async function breakdown(input) {
    const { kind, from, to, limit, cursor } = reportBreakdownInput(input);
    const ledgerEpoch = (await one('SELECT ledger_epoch FROM book_identity WHERE singleton=1')).ledger_epoch;
    if (cursor) requireLedgerEpoch(cursor.ledgerEpoch, ledgerEpoch);
    const table = kind === 'payment' ? 'payment_records' : 'consumption_items', name = kind === 'payment' ? 'd.method' : 'd.name', id = kind === 'payment' ? "''" : "COALESCE(d.service_id,'')", cents = kind === 'payment' ? 'd.amount_cents' : 'd.line_total_cents', quantity = kind === 'payment' ? '1' : 'd.quantity';
    const movement = 'SELECT ' + name + ' AS name,' + id + ' AS id,(d.rowid-1)/' + BATCH + ' AS chunk,' + cents + ' AS cents,' + quantity + ' AS quantity,COALESCE(c.occurred_at,e.occurred_at) AS occurred_at FROM ' + table + ' d JOIN ledger_entries e ON e.store_id=d.store_id AND e.entry_id=d.entry_id LEFT JOIN entry_confirmations c ON c.store_id=e.store_id AND c.entry_id=e.entry_id WHERE d.store_id=? UNION ALL SELECT ' + name + ',' + id + ',(d.rowid-1)/' + BATCH + ',-' + cents + ',-' + quantity + ',COALESCE(c.occurred_at,e.occurred_at) FROM ledger_entries e JOIN ledger_reversals r ON r.store_id=e.store_id AND r.reversal_entry_id=e.entry_id JOIN ' + table + ' d ON d.store_id=r.store_id AND d.entry_id=r.original_entry_id LEFT JOIN entry_confirmations c ON c.store_id=e.store_id AND c.entry_id=e.entry_id WHERE e.store_id=?';
    let scan = cursor ? { name: cursor.name, id: cursor.id, chunk: '9223372036854775807' } : null, hasMore = false;
    const groups = new Map();
    outer: for (;;) {
      const rows = await all('WITH movements AS (' + movement + '),chunks AS (SELECT name,id,chunk,SUM(quantity) AS quantity,' + sums({ amount: 'cents' }) + ' FROM movements WHERE occurred_at>=? AND occurred_at<? GROUP BY name,id,chunk) SELECT * FROM chunks WHERE (? IS NULL OR name>? OR (name=? AND id>?) OR (name=? AND id=? AND chunk>CAST(? AS INTEGER))) ORDER BY name,id,chunk LIMIT ' + PAGE, [storeId, storeId, from, to, scan?.name ?? null, scan?.name ?? '', scan?.name ?? '', scan?.id ?? '', scan?.name ?? '', scan?.id ?? '', scan?.chunk ?? '-1']);
      for (const row of rows) {
        const key = JSON.stringify([row.name, row.id]);
        if (!groups.has(key)) { if (groups.size === limit) { hasMore = true; break outer; } groups.set(key, { name: row.name, id: row.id, quantity: 0n, amount: 0n }); }
        const group = groups.get(key); group.quantity += BigInt(row.quantity); add(group, row, ['amount']); scan = { name: row.name, id: row.id, chunk: String(row.chunk) };
      }
      if (rows.length < PAGE) break;
    }
    const page = [...groups.values()], last = page.at(-1);
    return { kind, from, to, items: page.map(row => ({ name: row.name, ...(kind === 'service' ? { serviceId: row.id || null, quantity: String(row.quantity) } : {}), amountCents: String(row.amount) })), nextCursor: hasMore ? reportCursor({ kind, from, to, name: last.name, id: last.id, ledgerEpoch }) : null, localState: await localState() };
  }
  return { summary, breakdown, business: sqliteBusinessReports({ all, one, storeId, localState }) };
}
