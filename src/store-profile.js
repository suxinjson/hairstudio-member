export const APP_NAME = '会员管家';
export const STORE_PROFILE_KEY = 'member_store_profile_v1';
export const DEFAULT_STORE_PROFILE = Object.freeze({
  name: '我的门店', phone: '', address: '', memberNotesLabel: '会员偏好与备注',
  welcomeText: '{store}欢迎您，请说', rechargeThanks: '感谢您的支持与惠顾，祝您生活愉快！', version: 0
});
const limits = { name: 128, phone: 64, address: 256, memberNotesLabel: 32, welcomeText: 200, rechargeThanks: 300 };
export function normalizeStoreProfile(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('门店设置格式无效');
  const result = { ...DEFAULT_STORE_PROFILE };
  for (const [key, limit] of Object.entries(limits)) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || value[key].length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value[key])) throw new Error('门店设置字段无效：' + key);
    result[key] = value[key].trim();
    if (['name', 'memberNotesLabel', 'welcomeText'].includes(key) && !result[key]) throw new Error('门店名称、备注标题与欢迎词不能为空');
  }
  if (Number.isSafeInteger(value.version) && value.version >= 0) result.version = value.version;
  return result;
}
export function readLocalStoreProfile(storage = globalThis.localStorage) {
  const raw = storage?.getItem(STORE_PROFILE_KEY);
  return raw ? normalizeStoreProfile(JSON.parse(raw)) : { ...DEFAULT_STORE_PROFILE };
}
export function storeFilePrefix(profile) {
  return normalizeStoreProfile(profile).name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 80) || APP_NAME;
}
export function storeWelcome(profile) {
  const normalized = normalizeStoreProfile(profile);
  return normalized.welcomeText.replaceAll('{store}', normalized.name);
}
export function latestStoreProfile(current, incoming) {
  const next = normalizeStoreProfile(incoming);
  return current && normalizeStoreProfile(current).version > next.version ? normalizeStoreProfile(current) : next;
}
