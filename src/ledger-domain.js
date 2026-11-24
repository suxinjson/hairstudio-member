const MIN_CENTS = -(1n << 63n);
const MAX_CENTS = (1n << 63n) - 1n;
const INTEGER = /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/;

export function parseCents(value, label = '金额') {
  if (typeof value !== 'string' || value.length > 20 || !INTEGER.test(value)) throw new Error(label + '必须是十进制整数字符串（分）');
  const cents = BigInt(value);
  if (cents < MIN_CENTS || cents > MAX_CENTS) throw new Error(label + '超出 BIGINT 范围');
  return cents;
}

export function centsString(value) {
  const cents = typeof value === 'bigint' ? value : parseCents(value);
  if (cents < MIN_CENTS || cents > MAX_CENTS) throw new Error('金额超出 BIGINT 范围');
  return cents.toString();
}

function nonNegativeCents(value, label, { zero = true } = {}) {
  const cents = parseCents(value, label);
  if (cents < 0n || (!zero && cents === 0n)) throw new Error(label + (zero ? '不能为负数' : '必须大于零'));
  return cents;
}

export function applyDelta(balance, delta) {
  const before = parseCents(balance, '当前余额');
  const change = parseCents(typeof delta === 'bigint' ? delta.toString() : delta, '余额变化');
  const after = before + change;
  if (after < MIN_CENTS || after > MAX_CENTS) throw new Error('交易后余额超出 BIGINT 范围');
  return { balanceBeforeCents: before.toString(), deltaCents: change.toString(), balanceAfterCents: after.toString() };
}

export function createRecharge({ actualPayCents, giftCents = '0' }) {
  const actual = nonNegativeCents(actualPayCents, '实付金额', { zero: false });
  const gift = nonNegativeCents(giftCents, '赠送金额');
  if (actual + gift > MAX_CENTS) throw new Error('充值金额超出 BIGINT 范围');
  return { kind: 'recharge', actualPayCents: actual.toString(), giftCents: gift.toString(), deltaCents: (actual + gift).toString() };
}

export function createConsumption({ amountCents, allowDebt = false }) {
  const amount = nonNegativeCents(amountCents, '消费金额', { zero: false });
  if (typeof allowDebt !== 'boolean') throw new Error('欠款确认必须是布尔值');
  return { kind: 'consume', actualPayCents: '0', giftCents: '0', deltaCents: (-amount).toString(), allowDebt };
}

export function applyFinancialCommand(balance, command) {
  const before = parseCents(balance, '当前余额');
  const delta = parseCents(command.deltaCents, '余额变化');
  const result = applyDelta(before.toString(), delta);
  if (delta < 0n && BigInt(result.balanceAfterCents) < 0n && command.allowDebt !== true) throw new Error('余额不足，确认欠款后才能继续');
  return result;
}

export function createReversal({ originalKind, originalDeltaCents, currentBalanceCents, allowDebt = false }) {
  if (!['recharge', 'consume', 'adjustment'].includes(originalKind)) throw new Error('该流水不能撤销');
  const originalDelta = parseCents(originalDeltaCents, '原流水金额');
  if (originalDelta === 0n) throw new Error('零金额流水不能撤销');
  if (typeof allowDebt !== 'boolean') throw new Error('欠款确认必须是布尔值');
  const deltaCents = (-originalDelta).toString();
  parseCents(deltaCents, '冲正金额');
  const balances = applyDelta(currentBalanceCents, deltaCents);
  if (BigInt(balances.balanceAfterCents) < 0n && allowDebt !== true) throw new Error('撤销后会形成欠款，请先确认');
  return { kind: 'reversal', ...balances, originalDeltaCents: originalDelta.toString(), allowDebt };
}
