import { requireFeature } from './entitlements.js';
import { reportBreakdownInput, reportCursor } from '../src/relational-reports.js';
import { createBusinessReportService } from './relational-business-reports.js';
import { requireLedgerEpoch } from '../src/ledger-epoch.js';
export { reportPeriod } from '../src/relational-reports.js';
export function createReportService({ withAuthorized }) {
  return {
    ...createBusinessReportService({ withAuthorized }),
    async reportBreakdown(identity, input = {}) {
      const { from, to, kind, limit, cursor } = reportBreakdownInput(input);
      return withAuthorized(identity, 'read', async (client, user) => {
        requireFeature(user.entitlements, 'reports');
        if (input.ledgerEpoch !== undefined) requireLedgerEpoch(input.ledgerEpoch, user.ledger_epoch);
        if (cursor) requireLedgerEpoch(cursor.ledgerEpoch, user.ledger_epoch);
        const movement = kind === 'payment' ? `SELECT p.method AS name,''::text AS id,1::bigint AS quantity,p.amount_cents::numeric AS cents,e.occurred_at FROM payment_records p JOIN ledger_entries e ON e.store_id=p.store_id AND e.entry_id=p.entry_id WHERE p.store_id=$1
          UNION ALL SELECT p.method,''::text,-1::bigint,-p.amount_cents::numeric,e.occurred_at FROM ledger_entries e JOIN ledger_reversals r ON r.store_id=e.store_id AND r.reversal_entry_id=e.entry_id JOIN payment_records p ON p.store_id=r.store_id AND p.entry_id=r.original_entry_id WHERE e.store_id=$1` :
          `SELECT i.name,COALESCE(i.service_id,'') AS id,i.quantity::bigint,i.line_total_cents::numeric AS cents,e.occurred_at FROM consumption_items i JOIN ledger_entries e ON e.store_id=i.store_id AND e.entry_id=i.entry_id WHERE i.store_id=$1
          UNION ALL SELECT i.name,COALESCE(i.service_id,''),-i.quantity::bigint,-i.line_total_cents::numeric,e.occurred_at FROM ledger_entries e JOIN ledger_reversals r ON r.store_id=e.store_id AND r.reversal_entry_id=e.entry_id JOIN consumption_items i ON i.store_id=r.store_id AND i.entry_id=r.original_entry_id WHERE e.store_id=$1`;
        const { rows } = await client.query(`WITH movements AS (${movement}), totals AS (SELECT name,id,sum(quantity)::text AS quantity,sum(cents)::text AS amount_cents FROM movements WHERE occurred_at>=$2::timestamptz AND occurred_at<$3::timestamptz GROUP BY name,id)
          SELECT * FROM totals WHERE ($4::text IS NULL OR (name COLLATE "C",id COLLATE "C")>($4::text COLLATE "C",$5::text COLLATE "C")) ORDER BY name COLLATE "C",id COLLATE "C" LIMIT $6`, [user.store_id, from, to, cursor?.name ?? null, cursor?.id ?? null, limit + 1]);
        const page = rows.slice(0, limit), last = page.at(-1);
        return { kind, from, to, items: page.map(row => ({ name: row.name, ...(kind === 'service' ? { serviceId: row.id || null, quantity: row.quantity } : {}), amountCents: row.amount_cents })),
          nextCursor: rows.length > limit ? reportCursor({ kind, from, to, name: last.name, id: last.id, ledgerEpoch: user.ledger_epoch }) : null };
      }, { consistentRead: true });
    }
  };
}
