import { parseCents, centsString } from './ledger-domain.js';
import { boundedText } from './data-limits.js';

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
function bad(message, code = 'INVALID_INPUT', status = 400) { return Object.assign(new Error(message), { status, code }); }
function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw bad('配置或成交明细包含不支持的字段');
}
function str(value, max, label) { boundedText(value, max, label, true); return value.trim(); }
function id(value) { if (typeof value !== 'string' || !ID.test(value)) throw bad('配置实体单号无效'); return value; }
function version(value) { if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw bad('配置版本必须是非负 BIGINT 整数字符串'); parseCents(value, '配置版本'); return value; }
function money(value, positive = false) { const amount = parseCents(value); if (amount < 0n || positive && amount === 0n) throw bad('成交金额必须' + (positive ? '大于零' : '非负')); return amount; }
function list(value, max, label) { if (!Array.isArray(value) || value.length > max) throw bad(label + '数量无效'); return value; }
export const emptyConfiguration = () => ({ version: '0', services: [], rechargePlans: [], rechargeSettings: { giftEnabled: true, giftRateBasisPoints: 1000 } });

export function configurationInput(input) {
  fields(input, ['expectedVersion', 'services', 'rechargePlans', 'rechargeSettings']); version(input.expectedVersion);
  const services = list(input.services, 500, '服务项目').map(row => { fields(row, ['id', 'name', 'priceCents']); money(row.priceCents); return { id: id(row.id), name: str(row.name, 128, '服务项目名称'), priceCents: row.priceCents }; });
  const rechargePlans = list(input.rechargePlans, 200, '充值套餐').map(row => { fields(row, ['id', 'payCents', 'giftCents']); const pay = money(row.payCents, true), gift = money(row.giftCents); centsString(pay + gift); return { id: id(row.id), payCents: row.payCents, giftCents: row.giftCents }; });
  for (const rows of [services, rechargePlans]) if (new Set(rows.map(row => row.id)).size !== rows.length) throw bad('配置单号不能重复');
  fields(input.rechargeSettings, ['giftEnabled', 'giftRateBasisPoints']);
  const { giftEnabled, giftRateBasisPoints } = input.rechargeSettings;
  if (typeof giftEnabled !== 'boolean' || !Number.isInteger(giftRateBasisPoints) || giftRateBasisPoints < 0 || giftRateBasisPoints > 10000) throw bad('赠送开关或比例无效');
  if (!giftEnabled && rechargePlans.some(row => row.giftCents !== '0')) throw bad('关闭赠送时不能配置带赠送的套餐');
  return { expectedVersion: input.expectedVersion, services, rechargePlans, rechargeSettings: { giftEnabled, giftRateBasisPoints } };
}

export function validateSaleFields(command) {
  if (command.configurationVersion !== undefined) version(command.configurationVersion);
  if (command.planId !== undefined) { id(command.planId); if (command.configurationVersion === undefined) throw bad('使用充值套餐须提供配置版本'); }
  if (command.items !== undefined) {
    const items = list(command.items, 100, '成交项目'); if (!items.length) throw bad('成交项目不能为空'); let total = 0n;
    for (const row of items) {
      fields(row, ['serviceId', 'name', 'quantity', 'unitPriceCents']);
      if (row.serviceId !== undefined) { id(row.serviceId); if (command.configurationVersion === undefined) throw bad('使用服务项目须提供配置版本'); }
      str(row.name, 128, '成交项目名称');
      if (!Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 9999) throw bad('成交项目数量须为 1–9999 的整数');
      total += money(row.unitPriceCents) * BigInt(row.quantity); centsString(total);
    }
    if (String(total) !== command.amountCents) throw bad('成交项目合计必须等于消费金额');
  }
  if (command.payments !== undefined) {
    const rows = list(command.payments, 16, '付款明细'); if (!rows.length || command.payMethod !== undefined) throw bad('付款明细不能为空，且不能同时指定 payMethod');
    let total = 0n;
    for (const row of rows) { fields(row, ['method', 'amountCents']); str(row.method, 64, '付款方式'); total += money(row.amountCents, true); centsString(total); }
    if (String(total) !== command.actualPayCents) throw bad('付款合计必须等于实付金额');
  }
}

// All prices below are captured values, never live joins in historical queries.
// Call within the same transaction that reads the configuration and writes funds.
export function prepareSale(command, configuration) {
  validateSaleFields(command);
  if (command.type === 'reverse') return { items: [], payments: [], recharge: null };
  if (command.configurationVersion !== undefined && command.configurationVersion !== configuration.version) throw bad('配置已变化，请重新核对成交价格和赠送规则', 'CONFIGURATION_VERSION_CHANGED', 409);
  if (command.type === 'consume') {
    const items = command.items ?? [{ name: (command.itemsSummary ?? '消费').slice(0, 128) || '消费', quantity: 1, unitPriceCents: command.amountCents }];
    for (const item of items) if (item.serviceId !== undefined) {
      const service = configuration.services.find(row => row.id === item.serviceId);
      if (!service || service.name !== item.name.trim() || service.priceCents !== item.unitPriceCents) throw bad('服务项目已停用或成交价格不匹配', 'SALE_PRICE_CHANGED', 409);
    }
    return { items: items.map(row => ({ serviceId: row.serviceId ?? null, name: row.name.trim(), quantity: row.quantity, unitPriceCents: row.unitPriceCents, lineTotalCents: centsString(BigInt(row.unitPriceCents) * BigInt(row.quantity)) })), payments: [], recharge: null };
  }
  const gift = command.giftCents ?? '0';
  if (!configuration.rechargeSettings.giftEnabled && BigInt(gift) > 0n) throw bad('充值赠送已关闭', 'GIFT_DISABLED', 409);
  const plan = command.planId === undefined ? null : configuration.rechargePlans.find(row => row.id === command.planId);
  if (command.planId !== undefined && (!plan || plan.payCents !== command.actualPayCents || plan.giftCents !== gift)) throw bad('充值套餐已停用或成交金额不匹配', 'SALE_PRICE_CHANGED', 409);
  return { items: [], payments: command.payments?.map(row => ({ method: row.method.trim(), amountCents: row.amountCents })) ?? [{ method: command.payMethod?.trim() || '未注明', amountCents: command.actualPayCents }],
    recharge: { configurationVersion: configuration.version, planId: plan?.id ?? null, actualPayCents: command.actualPayCents, giftCents: gift, ...configuration.rechargeSettings } };
}

export function saleSnapshot(entry) {
  const items = list(entry.items, 100, '成交项目'), payments = list(entry.payments, 16, '付款明细');
  if (entry.type === 'consume') {
    if (!items.length || payments.length || entry.recharge !== null) throw bad('消费快照类型无效');
    for (const row of items) {
      fields(row, ['serviceId', 'name', 'quantity', 'unitPriceCents', 'lineTotalCents']);
      if (row.serviceId !== null) id(row.serviceId);
      if (!Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 9999 || String(money(row.unitPriceCents) * BigInt(row.quantity)) !== row.lineTotalCents) throw bad('成交行合计不匹配');
    }
    validateSaleFields({ configurationVersion: '0', amountCents: String(-parseCents(entry.deltaCents)), items: items.map(({ lineTotalCents, serviceId, ...row }) => ({ ...row, ...(serviceId === null ? {} : { serviceId }) })) });
  } else if (entry.type === 'recharge') {
    if (items.length || !payments.length) throw bad('充值快照类型无效');
    const row = entry.recharge; fields(row, ['configurationVersion', 'planId', 'actualPayCents', 'giftCents', 'giftEnabled', 'giftRateBasisPoints']);
    version(row.configurationVersion); if (row.planId !== null) id(row.planId);
    configurationInput({ expectedVersion: row.configurationVersion, services: [], rechargePlans: [], rechargeSettings: { giftEnabled: row.giftEnabled, giftRateBasisPoints: row.giftRateBasisPoints } });
    if (row.actualPayCents !== entry.actualPayCents || row.giftCents !== entry.giftCents || !row.giftEnabled && row.giftCents !== '0' || String(money(row.actualPayCents, true) + money(row.giftCents)) !== entry.deltaCents) throw bad('充值快照金额不匹配');
    validateSaleFields({ actualPayCents: entry.actualPayCents, payments });
  } else if (items.length || payments.length || entry.recharge !== null) throw bad('冲正不能包含新的成交或付款');
  return JSON.parse(JSON.stringify({ items, payments, recharge: entry.recharge }));
}
