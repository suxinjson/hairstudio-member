import { ApiError } from './security.js';

export const DEFAULT_OFFLINE_HOURS = 7 * 24;
export async function ensureDevice(client, user, deviceId, kind = 'web', fingerprint = null, deviceName = '') {
  if (fingerprint !== null && !/^[a-f0-9]{64}$/.test(fingerprint)) throw new ApiError(400, '设备指纹无效');
  if (typeof deviceName !== 'string' || deviceName.length > 128) throw new ApiError(400, '设备名称无效');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['device:' + user.store_id + ':' + (fingerprint || deviceId)]);
  // Preserve the policy when an old installation ID changes on the same Android device.
  const { rows: [previous] } = fingerprint ? await client.query(`SELECT * FROM app_devices WHERE store_id=$1 AND hardware_fingerprint=$2
    ORDER BY created_at LIMIT 1`, [user.store_id, fingerprint]) : { rows: [] };
  await client.query(`INSERT INTO app_devices(store_id,device_id,kind,last_user_id,hardware_fingerprint,active,offline_hours,authorized_until)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(store_id,device_id) DO UPDATE SET last_user_id=$4,
    hardware_fingerprint=COALESCE(app_devices.hardware_fingerprint,$5),kind=CASE WHEN $3='native' THEN 'native' ELSE app_devices.kind END`,
    [user.store_id, deviceId, kind, user.id, fingerprint, previous?.active ?? true, previous?.offline_hours ?? DEFAULT_OFFLINE_HOURS, previous?.authorized_until ?? null]);
  if (deviceName) await client.query('UPDATE app_devices SET device_name=$1 WHERE store_id=$2 AND device_id=$3', [deviceName.trim(), user.store_id, deviceId]);
  return checkDevice(client, user.store_id, deviceId);
}
export async function checkDevice(client, storeId, deviceId) {
  // Hold this lock through each accounting transaction: disabling waits for in-flight writes.
  const { rows: [device] } = await client.query('SELECT * FROM app_devices WHERE store_id=$1 AND device_id=$2 FOR SHARE', [storeId, deviceId]);
  if (!device) return null; // Legacy sessions are enrolled on their next refresh.
  if (device.hardware_fingerprint) {
    const { rows: linked } = await client.query('SELECT active,authorized_until,offline_hours FROM app_devices WHERE store_id=$1 AND hardware_fingerprint=$2 ORDER BY device_id FOR SHARE', [storeId, device.hardware_fingerprint]);
    device.active = linked.every(d => d.active);
    device.offline_hours = Math.min(...linked.map(d => d.offline_hours));
    const expiries = linked.filter(d => d.authorized_until).map(d => new Date(d.authorized_until).getTime());
    if (expiries.length) device.authorized_until = new Date(Math.min(...expiries));
  }
  if (!device.active) throw new ApiError(403, '此设备已被管理员禁用，请联系店主', 'DEVICE_DISABLED');
  if (device.authorized_until && new Date(device.authorized_until).getTime() <= Date.now()) {
    throw new ApiError(403, '此设备授权已到期，请联系店主续期', 'DEVICE_EXPIRED');
  }
  return device;
}
export function deviceGrant(device) {
  return { deviceId: device.device_id, active: device.active, offlineHours: device.offline_hours,
    authorizedUntil: device.authorized_until ? new Date(device.authorized_until).toISOString() : null,
    serverTime: new Date().toISOString() };
}
