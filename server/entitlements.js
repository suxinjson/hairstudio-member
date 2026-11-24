import { ApiError, publicUser } from './security.js';
import { LICENSE_FEATURES, allowsFeature, operationFeature } from '../src/license-policy.js';

export function normalizeFeatures(value) {
  if (!Array.isArray(value) || value.length > LICENSE_FEATURES.length || value.some(item => !LICENSE_FEATURES.includes(item)) || new Set(value).size !== value.length) throw new ApiError(400, '授权功能列表无效');
  return [...value].sort();
}
export async function storeEntitlement(client, storeId, { lock = true, feature = 'core' } = {}) {
  const { rows: [row] } = await client.query('SELECT s.status,l.id,l.active,l.expires_at,l.starts_at,l.offline_hours,l.features,l.version FROM stores s LEFT JOIN store_licenses l ON l.store_id=s.id WHERE s.id=$1' + (lock ? ' FOR SHARE OF s' : ''), [storeId]);
  if (!row || row.status !== 'active') throw new ApiError(403, '门店已被平台停用，请联系服务商', 'STORE_DISABLED');
  // PostgreSQL cannot lock the nullable side of an outer join.
  const license = lock ? (await client.query('SELECT * FROM store_licenses WHERE store_id=$1 FOR SHARE', [storeId])).rows[0] : row;
  if (!license?.id || !license.active) throw new ApiError(403, '门店尚未授权或授权已停用，请联系服务商', 'LICENSE_REQUIRED');
  if (new Date(license.starts_at).getTime() > Date.now() || license.expires_at && new Date(license.expires_at).getTime() <= Date.now()) throw new ApiError(403, '门店授权未生效或已到期', 'LICENSE_EXPIRED');
  if (!allowsFeature(license.features, feature)) throw new ApiError(403, '商业授权未包含此功能', 'FEATURE_DISABLED');
  return { licenseId: license.id, features: license.features, expiresAt: license.expires_at ? new Date(license.expires_at).toISOString() : null, offlineHours: license.offline_hours, version: license.version };
}
export function requireFeature(entitlement, feature) {
  if (!allowsFeature(entitlement?.features, feature)) throw new ApiError(403, '商业授权未包含此功能', 'FEATURE_DISABLED');
}
export function requireOperation(entitlement, method) { requireFeature(entitlement, operationFeature(method)); }
export function commercialGrant(grant, entitlement, user) {
  const expiry = [grant.authorizedUntil, entitlement.expiresAt].filter(Boolean).map(value => new Date(value).getTime());
  return { ...grant, offlineHours: Math.min(grant.offlineHours, entitlement.offlineHours),
    authorizedUntil: expiry.length ? new Date(Math.min(...expiry)).toISOString() : null,
    features: entitlement.features, licenseId: entitlement.licenseId, ...(user ? { user: publicUser(user) } : {}) };
}
