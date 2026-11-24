import { requireFeature } from './entitlements.js';
import { businessReportInput, businessReportResult, reportCount } from '../src/relational-reports.js';
import { requireLedgerEpoch } from '../src/ledger-epoch.js';

const money = {
  actualPayCents: 'e.actual_pay_cents', giftCents: 'e.gift_cents',
  consumptionCents: "CASE WHEN e.kind='consume' THEN -e.delta_cents::numeric ELSE 0 END",
  reversedActualPayCents: 'COALESCE(o.actual_pay_cents,0)', reversedGiftCents: 'COALESCE(o.gift_cents,0)',
  reversedConsumptionCents: "CASE WHEN o.kind='consume' THEN -o.delta_cents::numeric ELSE 0 END", netChangeCents: 'e.delta_cents'
};
const counters = { rechargeCount: "e.kind='recharge'", consumeCount: "e.kind='consume'", reversalCount: "e.kind='reversal'", reversedRechargeCount: "o.kind='recharge'", reversedConsumeCount: "o.kind='consume'" };
const joins = ' FROM ledger_entries e LEFT JOIN ledger_reversals r ON r.store_id=e.store_id AND r.reversal_entry_id=e.entry_id LEFT JOIN ledger_entries o ON o.store_id=r.store_id AND o.entry_id=r.original_entry_id';
export function createBusinessReportService({ withAuthorized }) {
  return {
    async reportBusiness(identity, input = {}) {
      const period = businessReportInput(input), { from, to, offsetMinutes } = period;
      return withAuthorized(identity, 'read', async (client, user) => {
        requireFeature(user.entitlements, 'reports');
        if (input.ledgerEpoch !== undefined) requireLedgerEpoch(input.ledgerEpoch, user.ledger_epoch);
        const params = [user.store_id, from, to, offsetMinutes];
        const sums = Object.entries(money).map(([key, expression]) => 'COALESCE(sum((' + expression + ')::numeric),0)::text AS "' + key + '"');
        const counts = Object.entries(counters).map(([key, condition]) => 'count(*) FILTER(WHERE ' + condition + ')::text AS "' + key + '"');
        const { rows: daily } = await client.query('SELECT to_char((e.occurred_at AT TIME ZONE \'UTC\')+($4::integer*interval \'1 minute\'),\'YYYY-MM-DD\') AS date,' + [...sums, ...counts].join(',') + joins + ' WHERE e.store_id=$1 AND e.occurred_at>=$2::timestamptz AND e.occurred_at<$3::timestamptz GROUP BY date ORDER BY date', params);
        const { rows: newMembers } = await client.query(`SELECT to_char((m.created_at AT TIME ZONE 'UTC')+($4::integer*interval '1 minute'),'YYYY-MM-DD') AS date,count(*)::text AS "newActiveMemberCount"
          FROM member_profiles m WHERE m.store_id=$1 AND m.archived_at IS NULL AND m.created_at>=$2::timestamptz AND m.created_at<$3::timestamptz
          AND NOT EXISTS(SELECT 1 FROM account_openings b WHERE b.store_id=m.store_id AND b.member_id=m.id) GROUP BY date ORDER BY date`, params);
        const { rows: [members] } = await client.query("SELECT count(DISTINCT member_id)::text AS n FROM ledger_entries WHERE store_id=$1 AND kind='consume' AND occurred_at>=$2::timestamptz AND occurred_at<$3::timestamptz", params.slice(0, 3));
        const { rows: [balances] } = await client.query(`SELECT count(*)::text AS "memberCount",count(*) FILTER(WHERE a.balance_cents<0)::text AS "debtCount",count(*) FILTER(WHERE a.balance_cents=0)::text AS "zeroCount",
          count(*) FILTER(WHERE a.balance_cents>0 AND a.balance_cents<=5000)::text AS "lowCount",count(*) FILTER(WHERE a.balance_cents>5000)::text AS "fundedCount",
          COALESCE(sum(CASE WHEN a.balance_cents>0 THEN a.balance_cents ELSE 0 END),0)::text AS "storedCents",COALESCE(sum(CASE WHEN a.balance_cents<0 THEN a.balance_cents ELSE 0 END),0)::text AS "debtCents"
          FROM member_accounts a JOIN member_profiles m ON m.store_id=a.store_id AND m.id=a.member_id WHERE a.store_id=$1 AND m.archived_at IS NULL`, [user.store_id]);
        for (const key of ['memberCount', 'debtCount', 'zeroCount', 'lowCount', 'fundedCount']) balances[key] = reportCount(balances[key]);
        const { rows: ranked } = await client.query(`WITH amounts AS (SELECT e.member_id,
          CASE WHEN e.kind='consume' THEN -e.delta_cents::numeric WHEN o.kind='consume' THEN o.delta_cents::numeric ELSE 0 END AS amount,
          CASE WHEN e.kind='consume' THEN 1 WHEN o.kind='consume' THEN -1 ELSE 0 END AS n` + joins + ` WHERE e.store_id=$1 AND e.occurred_at>=$2::timestamptz AND e.occurred_at<$3::timestamptz AND (e.kind='consume' OR o.kind='consume')),
          totals AS (SELECT member_id,sum(amount) AS amount,sum(n)::text AS n FROM amounts GROUP BY member_id HAVING sum(amount)<>0)
          SELECT t.member_id,m.name,t.amount::text AS amount,t.n FROM totals t JOIN member_profiles m ON m.store_id=$1 AND m.id=t.member_id ORDER BY t.amount DESC,t.n::numeric DESC,t.member_id COLLATE "C" LIMIT 10`, params.slice(0, 3));
        return businessReportResult(period, { daily: [...daily, ...newMembers], balances, consumeMemberCount: members.n,
          ranking: ranked.map(row => ({ memberId: row.member_id, name: row.name, netConsumptionCents: row.amount, netConsumeCount: reportCount(row.n) })) });
      }, { consistentRead: true });
    }
  };
}
