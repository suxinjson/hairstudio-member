import { digest, ApiError } from './security.js';

// Fingerprints only: these formerly public credentials must never be used again.
const revoked = new Set([
  "1405a6c20c17a14abbb81f9b1c14fe858c4be70e77da6316c97f8124153a502c",
  "a9686416e66aeffd7bbcc88575c6e5c6237b88c59c62d2dc1c26663a392796b1"
]);
export function assertUnexposedCredential(key) {
  if (revoked.has(digest(typeof key === 'string' ? key.trim() : ''))) throw new ApiError(400, '此凭据已公开暴露，请在供应商后台撤销并使用新密钥', 'EXPOSED_CREDENTIAL');
}
