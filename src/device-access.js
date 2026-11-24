import { verifyOfflineLicense, createLocalCredential, verifyLocalCredential } from './offline-license.js';
import { allowsFeature, operationFeature } from './license-policy.js';
export const DEFAULT_OFFLINE_HOURS = 168;
const HOUR = 3600000;
const unavailable = message => Object.assign(new Error(message), { code: 'DEVICE_ACCESS_REQUIRED' });

// This state is stored by the native plugin, separately from the ledger and session.
// Reopening, logging out and restoring a ledger must never restart a lease.
export function createDeviceAccess({ vault, now = () => Date.now(), monotonic = () => performance.now(), licenseKeys } = {}) {
  let saved = null, ready = false, loading = null, anchor = 0, anchorTick = 0, rollback = false;
  let onlineUntil = 0, storageError = '', saveTail = Promise.resolve();
  let claims = null, currentDeviceId = null;
  const time = () => Math.max(anchor + Math.max(0, monotonic() - anchorTick),
    saved ? saved.trustedTime + Math.max(0, now() - saved.localTime) : now());
  function persist() {
    if (saved && now() < saved.localTime - 5 * 60000) rollback = true;
    const value = { ...saved, rollback, trustedTime: time(), localTime: now() };
    saved = value; anchor = value.trustedTime; anchorTick = monotonic();
    saveTail = saveTail.catch(() => {}).then(() => vault.save(value));
    return saveTail.catch(error => { storageError = '无法保存设备授权，请联网重试'; throw error; });
  }
  return {
    async initialize(deviceId) {
      if (ready && claims && deviceId && claims.deviceId !== deviceId) throw unavailable('授权不属于当前设备');
      if (deviceId) currentDeviceId = deviceId;
      if (ready) return;
      if (loading) return loading;
      loading = (async () => {
        try {
          saved = await vault.load();
          if (!saved) {
            const start = now();
            saved = { trialUntil: 0, localTime: start, trustedTime: start, grant: null };
            anchor = start; anchorTick = monotonic();
            await persist();
          } else {
            if (!Number.isFinite(saved.localTime) || !Number.isFinite(saved.trustedTime)) throw unavailable('设备授权记录损坏，请联网登录');
            rollback = saved.rollback === true || now() < saved.localTime - 5 * 60000;
            anchor = saved.trustedTime + Math.max(0, now() - saved.localTime); anchorTick = monotonic();
          }
          if (saved.offlineActivation) claims = await verifyOfflineLicense(saved.offlineActivation.code, { deviceId: currentDeviceId, keys: licenseKeys });
          ready = true; storageError = '';
        } catch (error) { storageError = error.message || '无法读取设备授权，请联网登录'; throw error; }
      })().finally(() => { loading = null; });
      return loading;
    },
    async accept(grant, deviceId) {
      if (!grant || grant.deviceId !== deviceId || typeof grant.active !== 'boolean' ||
          !Number.isInteger(grant.offlineHours) || grant.offlineHours < 0 || grant.offlineHours > 8760 ||
          !Number.isFinite(Date.parse(grant.serverTime)) || grant.authorizedUntil !== null && !Number.isFinite(Date.parse(grant.authorizedUntil))) {
        throw unavailable('设备授权核验失败，请重新连接服务器');
      }
      const serverTime = Date.parse(grant.serverTime);
      claims = null; currentDeviceId = deviceId;
      saved = { trialUntil: 0, denied: null, localTime: now(), trustedTime: serverTime,
        grant: { ...grant, offlineUntil: Math.min(serverTime + grant.offlineHours * HOUR,
          grant.authorizedUntil ? Date.parse(grant.authorizedUntil) : Infinity) } };
      anchor = serverTime; anchorTick = monotonic(); rollback = false; storageError = '';
      onlineUntil = time() + 60000; ready = true;
      await persist();
    },
    localLicense() { return claims; },
    cachedUser() { return claims ? { ...claims.user, storeId: claims.storeId } : saved?.grant?.user || null; },
    inspectOffline(code, deviceId) { return verifyOfflineLicense(code, { deviceId, keys: licenseKeys }); },
    async activateOffline(code, password, deviceId) {
      await this.initialize(deviceId);
      const next = await verifyOfflineLicense(code, { deviceId, keys: licenseKeys });
      const trusted = Math.max(time(), Date.parse(next.issuedAt));
      if (Date.parse(next.notBefore) > trusted + 300000 || next.expiresAt && Date.parse(next.expiresAt) <= trusted) throw unavailable('离线授权未生效或已到期');
      if (!allowsFeature(next.features, 'core')) throw unavailable('授权未包含基础功能');
      const credential = await createLocalCredential(password);
      saved = { trialUntil: 0, localTime: now(), trustedTime: trusted, denied: null, grant: null, offlineActivation: { code: code.trim(), credential }, failedLogins: 0, blockedUntil: 0 };
      claims = next; anchor = trusted; anchorTick = monotonic(); rollback = false; storageError = ''; ready = true;
      await persist(); return claims;
    },
    async loginOffline(username, password) {
      if (!ready || !claims || typeof username !== 'string' || username.toLowerCase() !== claims.user.username) throw unavailable('本机尚未激活此离线账号');
      if (saved.blockedUntil > time()) throw unavailable('本地登录尝试过多，请稍后重试');
      const valid = await verifyLocalCredential(password, saved.offlineActivation?.credential);
      if (!valid) {
        saved.failedLogins = Math.min(10, (saved.failedLogins || 0) + 1);
        if (saved.failedLogins >= 5) saved.blockedUntil = time() + 15 * 60000;
        await persist(); throw unavailable('本地账号或密码错误');
      }
      saved.failedLogins = 0; saved.blockedUntil = 0; await persist();
      this.assert({ loggedIn: true }); return claims;
    },
    assertFeature(feature, options) {
      this.assert(options);
      if (!allowsFeature(this.snapshot(options).features, feature)) throw Object.assign(new Error('商业授权未包含此功能'), { code: 'FEATURE_DISABLED' });
    },
    assertOperation(method, options) { this.assertFeature(operationFeature(method), options); },
    async deny(code) {
      onlineUntil = 0;
      if (!saved) saved = { trialUntil: 0, localTime: now(), trustedTime: now(), grant: null };
      saved.denied = code;
      ready = true;
      await persist();
    },
    disconnect() { onlineUntil = 0; },
    async checkpoint() { if (ready && saved) await persist(); },
    snapshot({ connected = false, loggedIn = false } = {}) {
      const current = time(), grant = saved?.grant;
      let reason = '';
      if (!ready) reason = storageError || '正在核验设备使用权限…';
      else if (storageError) reason = storageError;
      else if (!loggedIn) reason = '请先登录，或激活离线授权后登录本地账号';
      else if (saved.denied) reason = '账号、门店或设备授权已失效，请联网登录或联系服务商';
      else if (rollback) reason = '手机时间发生变化，请联网确认使用权限';
      else if (claims) {
        if (current < Date.parse(claims.notBefore)) reason = '离线授权尚未生效';
        else if (claims.expiresAt && current >= Date.parse(claims.expiresAt)) reason = '离线授权已到期，请联系服务商续期';
        else if (!allowsFeature(claims.features, 'core')) reason = '授权未包含基础功能';
      } else if (grant) {
        if (!grant.active) reason = '此设备已被管理员禁用，请联系店主';
        else if (grant.authorizedUntil && current >= Date.parse(grant.authorizedUntil)) reason = '设备或门店授权已到期，请联系服务商续期';
        else if (!(connected && current < onlineUntil)) {
          if (!grant.offlineHours) reason = '此设备不允许离线使用，请联网登录';
          else if (current >= grant.offlineUntil) reason = '离线使用期限已到，请联网登录';
        }
      } else reason = '本机尚未获得有效授权，请联网登录或导入离线授权码';
      return { ready, allowed: !reason, reason, mode: claims ? 'offline' : 'online',
        features: claims?.features || grant?.features || [], licenseId: claims?.id || grant?.licenseId || null,
        localUsername: claims?.user.username || null, offlineHours: grant?.offlineHours ?? 0,
        offlineUntil: claims ? (claims.expiresAt ? Date.parse(claims.expiresAt) : null) : grant?.offlineUntil ?? null,
        disabled: Boolean(saved?.denied), authorizedUntil: claims?.expiresAt || grant?.authorizedUntil || null };
    },
    assert(options) { const status = this.snapshot(options); if (!status.allowed) throw unavailable(status.reason); }
  };
}
