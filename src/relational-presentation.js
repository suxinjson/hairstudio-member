import { centsString } from './ledger-domain.js';

export function displayCents(raw) {
  if (typeof raw !== 'string' || !/^(?:0|-?[1-9]\d{0,50})$/.test(raw)) return '—';
  const cents = BigInt(raw), absolute = cents < 0n ? -cents : cents;
  return (cents < 0n ? '-' : '') + (absolute / 100n).toString() + '.' + String(absolute % 100n).padStart(2, '0');
}

export function announceRelationalSale(player, result, draft, member) {
  const common = { name: member.name, balance: displayCents(result.balanceAfterCents) };
  if (draft.type === 'recharge') return player.broadcast('recharge', { ...common, amount: displayCents(draft.actualPayCents),
    gift: displayCents(draft.giftCents), totalCredit: displayCents(result.deltaCents) });
  if (draft.type === 'consume') return player.broadcast('consume', { ...common, amount: displayCents(draft.amountCents), items: draft.itemsSummary });
}

export function yuanCents(raw, { positive = false } = {}) {
  const parts = /^(\d{1,17})(?:\.(\d{1,2}))?$/.exec(String(raw).trim());
  if (!parts) throw new Error('请输入非负金额（元），最多两位小数');
  const cents = BigInt(parts[1]) * 100n + BigInt((parts[2] ?? '').padEnd(2, '0'));
  if (positive && cents === 0n) throw new Error('金额必须大于零');
  return centsString(cents);
}

export const BUSINESS_OFFSET = 480;
export const todayBusiness = () => new Date(Date.now() + BUSINESS_OFFSET * 60000).toISOString().slice(0, 10);
export function businessDays(first, last) {
  const date = day => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new Error('请填写起止日期');
    const utc = new Date(day + 'T00:00:00.000Z');
    if (!Number.isFinite(utc.valueOf()) || utc.toISOString().slice(0, 10) !== day) throw new Error('日期无效');
    return utc.valueOf() - BUSINESS_OFFSET * 60000;
  };
  const from = date(first), to = date(last) + 86400000;
  if (from >= to) throw new Error('结束日期不能早于起始日期');
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

export function suggestedGift(actualPayCents, settings) {
  return settings.giftEnabled ? centsString((BigInt(actualPayCents) * BigInt(settings.giftRateBasisPoints) + 5000n) / 10000n) : '0';
}
