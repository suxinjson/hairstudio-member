import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { canonicalJSON } from '../src/sync-protocol.js';
const scrypt = promisify(scryptCallback);
// Bound both native scrypt memory and its waiting queue across all requests.
let passwordJobs = 0;
const passwordQueue = [];
async function boundedScrypt(password, salt) {
  if (passwordJobs >= 4) {
    if (passwordQueue.length >= 16) throw new ApiError(503, '登录服务繁忙，请稍后重试', 'SERVER_BUSY');
    await new Promise(resolve => passwordQueue.push(resolve));
  } else passwordJobs++;
  try { return await scrypt(password, salt, 64); }
  finally { if (passwordQueue.length) passwordQueue.shift()(); else passwordJobs--; }
}
export function digest(value) { return createHash('sha256').update(value).digest('hex'); }
export function integrity(data) { return digest(canonicalJSON(data)); }
export function token() { return randomBytes(32).toString('base64url'); }
export function normalizeUsername(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.@-]{3,64}$/.test(value)) throw new ApiError(400, '账号须为 3–64 位英文、数字或 . _ @ -');
  return value.toLowerCase();
}
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new ApiError(400, '密码须为 12–128 位');
  const salt = randomBytes(16).toString('hex');
  return 'scrypt$' + salt + '$' + Buffer.from(await boundedScrypt(password, salt)).toString('hex');
}
export async function verifyPassword(password, stored) {
  const [, salt = 'dummy-account-salt', expected = '0'.repeat(128)] = String(stored || '').split('$');
  if (typeof password !== 'string' || password.length > 128) return false;
  const actual = Buffer.from(await boundedScrypt(password, salt));
  const bytes = Buffer.from(expected, 'hex');
  return actual.length === bytes.length && timingSafeEqual(actual, bytes);
}
export class ApiError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') { super(message); this.status = status; this.code = code; }
}
export function publicUser(user) {
  return { id: user.id, storeId: user.store_id, username: user.username, displayName: user.display_name, role: user.role };
}
