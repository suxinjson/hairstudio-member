export const SQLITE_AGGREGATE_BATCH = 10000, SQLITE_AGGREGATE_PAGE = 500;
const BASE = 1000000000n;
// At most 10,000 physical rows per group (20,000 after a reversal union).
// Both integer quotient/remainder sums stay inside signed BIGINT. Combining
// groups in JavaScript BigInt keeps totals exact even above signed BIGINT.
export function sqliteSums(fields) { return Object.entries(fields).flatMap(([name, expression]) => [
  'COALESCE(SUM((' + expression + ')/1000000000),0) AS ' + name + '_hi',
  'COALESCE(SUM((' + expression + ')%1000000000),0) AS ' + name + '_lo'
]).join(','); }
export function addSqliteSums(target, row, fields) {
  for (const name of fields) target[name] = (target[name] ?? 0n) + BigInt(row[name + '_hi']) * BASE + BigInt(row[name + '_lo']);
}
