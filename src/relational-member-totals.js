// Lifetime credit/consumption totals exclude opening balances and subtract
// reversed originals. Both repositories return exact decimal cents.
export const memberTotalFields = Object.freeze({
  grossRechargeCents: "CASE WHEN e.kind='recharge' THEN e.delta_cents ELSE 0 END",
  reversedRechargeCents: "CASE WHEN e.kind='recharge' AND r.original_entry_id IS NOT NULL THEN e.delta_cents ELSE 0 END",
  grossConsumptionCents: "CASE WHEN e.kind='consume' THEN -e.delta_cents ELSE 0 END",
  reversedConsumptionCents: "CASE WHEN e.kind='consume' AND r.original_entry_id IS NOT NULL THEN -e.delta_cents ELSE 0 END"
});

export function memberTotals(values) {
  const totals = Object.fromEntries(Object.keys(memberTotalFields).map(key => [key, BigInt(values[key] ?? 0)]));
  return {
    ...Object.fromEntries(Object.entries(totals).map(([key, amount]) => [key, String(amount)])),
    netRechargeCents: String(totals.grossRechargeCents - totals.reversedRechargeCents),
    netConsumptionCents: String(totals.grossConsumptionCents - totals.reversedConsumptionCents)
  };
}
