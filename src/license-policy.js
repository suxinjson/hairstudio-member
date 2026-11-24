// Shared identifiers only. No issuer secrets or server policy are shipped to clients.
export const LICENSE_FEATURES = Object.freeze(['core', 'members', 'cashier', 'reports', 'backup', 'voice', 'staff', 'devices', 'settings']);
export const OFFLINE_LICENSE_FEATURES = Object.freeze(LICENSE_FEATURES.filter(feature => !['voice', 'staff', 'devices'].includes(feature)));
export function operationFeature(method) {
  if (['createMember', 'updateMember', 'deleteMember', 'archiveMember', 'restoreMember'].includes(method)) return 'members';
  if (['consume', 'recharge', 'refundLedger', 'refund', 'adjustBalance'].includes(method)) return 'cashier';
  if (['importBackupData', 'exportBackupData', 'clearAllData', 'resetData'].includes(method)) return 'backup';
  if (['reports', 'report', 'reportBreakdown', 'reportBusiness'].includes(method)) return 'reports';
  return 'settings';
}
export function allowsFeature(features, feature) {
  return Array.isArray(features) && features.includes('core') && features.includes(feature);
}
