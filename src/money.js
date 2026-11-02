export function moneyToCent(value, label = '金额') {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{0,2})?$/.test(text)) {
    throw new Error(`${label}必须是非负且最多两位小数的金额`);
  }
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label}超出可处理范围`);
  return Number(cents);
}

export function isValidMoney(value) {
  try {
    moneyToCent(value);
    return true;
  } catch {
    return false;
  }
}
