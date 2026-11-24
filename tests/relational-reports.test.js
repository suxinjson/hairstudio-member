import test from 'node:test';
import assert from 'node:assert/strict';
import { reportPeriod, reportLimit, reportCursor, readReportCursor, reportBreakdownInput, businessReportInput, reportCount } from '../src/relational-reports.js';

const period = { from: '2026-11-18T16:00:00.000Z', to: '2026-11-19T16:00:00.000Z' };
test('report periods require exact calendar dates and explicit timezone, with a half-open millisecond boundary', () => {
  for (const input of [null, false, [], 1]) assert.throws(() => reportPeriod(input), { code: 'INVALID_INPUT' });
  assert.deepEqual(reportPeriod({ from: '2026-11-19T00:00:00+08:00', to: '2026-11-20T00:00:00+08:00' }), period);
  assert.deepEqual(reportPeriod({ from: '2024-02-29T00:00:00Z', to: '2024-03-01T00:00:00Z' }), { from: '2024-02-29T00:00:00.000Z', to: '2024-03-01T00:00:00.000Z' });
  for (const from of ['2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2026-00-01T00:00:00Z', '2026-11-31T00:00:00Z', '0000-01-01T00:00:00Z', '0001-01-01T00:00:00+23:00', '2026-11-19', '2026-11-19T00:00:00', 'yesterday', '2026-11-19T24:00:00Z', '2026-11-19T12:60:00Z', '2026-11-19T12:00:60Z', '2026-11-19T12:00:00.1234Z', '2026-11-19T00:00:00+24:00', null, 0]) {
    assert.throws(() => reportPeriod({ ...period, from }), { code: 'INVALID_INPUT' }, String(from));
  }
  for (const to of [period.from, '2026-11-17T00:00:00Z']) assert.throws(() => reportPeriod({ ...period, to }), { code: 'INVALID_INPUT' });
  assert.throws(() => reportPeriod({ from: '9999-12-31T00:00:00Z', to: '9999-12-31T23:59:59-01:00' }), { code: 'INVALID_INPUT' });
});
test('report group cursor is browser-safe canonical UTF-8 base64url and binds kind and normalized period', () => {
  const group = { kind: 'service', ...period, name: '剪发 ✂️ / 👩🏽‍🦱', id: 'service-1', ledgerEpoch: '00000000-0000-4000-8000-000000000001' }, cursor = reportCursor(group);
  assert.equal(cursor, Buffer.from(JSON.stringify(group)).toString('base64url'));
  assert.deepEqual(readReportCursor(cursor, group), group);
  assert.equal(readReportCursor(null, group), null);
  assert.equal(reportBreakdownInput({ kind: 'service', ...period, cursor, limit: '1' }).limit, 1);
  for (const invalid of ['!', cursor + '=', 'A', '____', 'eyJ', 'null', reportCursor({ ...group, name: 'bad\u0000' }), reportCursor({ ...group, kind: 'payment' }), reportCursor({ ...group, from: '2026-11-18T00:00:00.000Z' }), reportCursor({ ...group, extra: 1 }), 'a'.repeat(2049), Buffer.from([0xc0, 0xaf]).toString('base64url')]) {
    assert.throws(() => readReportCursor(invalid, group), { code: 'INVALID_INPUT' });
  }
  const tail = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const single = reportCursor({ ...group, name: 'A' });
  if (single.length % 4) {
    const index = tail.indexOf(single.at(-1)), changed = single.slice(0, -1) + tail[index ^ 1];
    assert.throws(() => readReportCursor(changed, group), { code: 'INVALID_INPUT' });
  }
});
test('report page limits reject coercions, zero, fractions and excessive pages', () => {
  assert.equal(reportLimit(), 50); assert.equal(reportLimit(100), 100); assert.equal(reportLimit('1'), 1);
  for (const value of [null, false, 0, 101, 1.1, '01', '1e1', ' 1', '', [], {}]) assert.throws(() => reportLimit(value), { code: 'INVALID_INPUT' });
  assert.throws(() => reportBreakdownInput({ ...period, kind: 'unknown' }), { code: 'INVALID_INPUT' });
});

test('business report calendar uses an explicit fixed UTC offset and caps calendar days before querying data', () => {
  assert.deepEqual(businessReportInput({ ...period, offsetMinutes: '480' }).days, ['2026-11-19']);
  assert.deepEqual(businessReportInput({ ...period, offsetMinutes: -480 }).days, ['2026-11-18', '2026-11-19']);
  assert.equal(businessReportInput({ from: '2024-01-01T00:00:00Z', to: '2025-01-01T00:00:00Z', offsetMinutes: 0 }).days.length, 366);
  for (const offsetMinutes of [841, -841, '1.5', 0.5, false, null, '', '0480']) assert.throws(() => businessReportInput({ ...period, offsetMinutes }), { code: 'INVALID_INPUT' });
  assert.throws(() => businessReportInput({ from: '2024-01-01T00:00:00Z', to: '2025-01-02T00:00:00Z', offsetMinutes: 0 }), { code: 'INVALID_INPUT' });
  assert.throws(() => businessReportInput({ from: '0001-01-01T00:00:00Z', to: '0001-01-01T01:00:00Z', offsetMinutes: -480 }), { code: 'INVALID_INPUT' });
  assert.throws(() => businessReportInput({ from: '9999-12-31T00:00:00Z', to: '9999-12-31T23:00:00Z', offsetMinutes: 480 }), { code: 'INVALID_INPUT' });
  assert.equal(reportCount('-2'), -2); assert.throws(() => reportCount('9007199254740992'), { code: 'REPORT_CAPACITY' });
});
