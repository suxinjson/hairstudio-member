import { LICENSE_FEATURES } from './license-policy.js';
const fail = message => Object.assign(new Error(message), { code: 'LICENSE_INVALID' });
function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw fail('授权码编码无效');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
}
export function configuredLicenseKeys() {
  try { return JSON.parse(import.meta.env?.VITE_LICENSE_PUBLIC_KEYS || '{}'); }
  catch { return {}; }
}
export async function verifyOfflineLicense(code, { deviceId, keys = configuredLicenseKeys() } = {}) {
  if (typeof code !== 'string' || code.length > 12000) throw fail('授权码无效');
  const parts = code.trim().split('.');
  if (parts.length !== 4 || parts[0] !== 'ML1' || !Object.hasOwn(keys, parts[1])) throw fail('授权码版本或签发密钥不受信任');
  const trusted = keys[parts[1]];
  if (!trusted || trusted.kty !== 'EC' || trusted.crv !== 'P-256' || trusted.d) throw fail('授权公钥配置无效');
  const key = await crypto.subtle.importKey('jwk', trusted, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const signature = decode(parts[3]);
  if (signature.length !== 64) throw fail('授权码签名格式无效');
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, new TextEncoder().encode(parts.slice(0, 3).join('.')));
  if (!valid) throw fail('授权码签名无效，不能启用本机');
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(parts[2]))); }
  catch { throw fail('授权内容无效'); }
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (payload.v !== 1 || payload.mode !== 'offline' || !uuid.test(payload.id) || !uuid.test(payload.storeId) ||
      !deviceId || payload.deviceId !== deviceId || typeof payload.storeName !== 'string' || payload.storeName.length < 1 || payload.storeName.length > 128 ||
      !Number.isFinite(Date.parse(payload.issuedAt)) || !Number.isFinite(Date.parse(payload.notBefore)) ||
      payload.expiresAt !== null && (!Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= Date.parse(payload.notBefore)) ||
      !Array.isArray(payload.features) || payload.features.some(feature => !LICENSE_FEATURES.includes(feature)) || new Set(payload.features).size !== payload.features.length ||
      !payload.user || !uuid.test(payload.user.id) || !/^[a-zA-Z0-9_.@-]{3,64}$/.test(payload.user.username) ||
      payload.user.role !== 'owner' || typeof payload.user.displayName !== 'string' || !payload.user.displayName || payload.user.displayName.length > 128) throw fail('授权内容与当前设备不匹配');
  return payload;
}
function hex(bytes) { return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join(''); }
async function passwordDigest(password, salt) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw fail('本地登录密码须为 12–128 位');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 600000 }, key, 256));
}
export async function createLocalCredential(password) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(24)));
  return { salt, hash: await passwordDigest(password, salt), algorithm: 'PBKDF2-SHA256-600000' };
}
export async function verifyLocalCredential(password, credential) {
  if (!credential || credential.algorithm !== 'PBKDF2-SHA256-600000' || !/^[a-f0-9]{48}$/.test(credential.salt || '') || !/^[a-f0-9]{64}$/.test(credential.hash || '')) return false;
  const actual = await passwordDigest(password, credential.salt);
  let diff = 0; for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ credential.hash.charCodeAt(i);
  return diff === 0;
}
