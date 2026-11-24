import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ApiError } from './security.js';

export function createLicenseSigner({ privateKey, keyId = 'main' } = {}) {
  if (!privateKey) return null;
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(keyId)) throw new Error('LICENSE_KEY_ID 无效');
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('授权签名必须使用 P-256 私钥');
  const publicKey = createPublicKey(key).export({ format: 'jwk' });
  return {
    keyId, publicKey,
    sign(payload) {
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const input = 'ML1.' + keyId + '.' + encoded;
      return input + '.' + sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    }
  };
}
export function configuredLicenseSigner() {
  if (!process.env.LICENSE_PRIVATE_KEY_FILE) return null;
  return createLicenseSigner({ privateKey: readFileSync(process.env.LICENSE_PRIVATE_KEY_FILE, 'utf8'), keyId: process.env.LICENSE_KEY_ID || 'main' });
}
export function licenseEnd(input, start = new Date()) {
  if (input.permanent === true && input.days === null) return null;
  if (input.permanent !== false || !Number.isInteger(input.days) || input.days < 1 || input.days > 36500) throw new ApiError(400, '请选择 1–36500 天期限，或显式选择永久授权');
  return new Date(start.getTime() + input.days * 86400000).toISOString();
}
