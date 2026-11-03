import { moneyToCent } from './money.js';

export const DEFAULT_RECHARGE_SETTINGS = Object.freeze({ giftEnabled: true, giftRate: 10 });

export function normalizeRechargeSettings(value = DEFAULT_RECHARGE_SETTINGS) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.giftEnabled !== 'boolean' ||
      typeof value.giftRate !== 'number' || !Number.isFinite(value.giftRate)) throw new Error('充值赠送设置格式无效');
  const rate = moneyToCent(value.giftRate, '赠送比例');
  if (rate > 10000) throw new Error('赠送比例须为 0–100%，最多两位小数');
  return { giftEnabled: value.giftEnabled, giftRate: rate / 100 };
}

export function rechargeGiftCent(actualPay, settings = DEFAULT_RECHARGE_SETTINGS) {
  const policy = normalizeRechargeSettings(settings);
  if (!policy.giftEnabled) return 0;
  // 整数分 × 万分比，四舍五入到分，避免浮点乘法误差。
  const result = (BigInt(moneyToCent(actualPay, '实收充值金额')) * BigInt(moneyToCent(policy.giftRate)) + 5000n) / 10000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('赠送金额超出可处理范围');
  return Number(result);
}
