export const DEFAULT_OFFLINE_HOURS = 168;
const HOUR = 3600000;
const unavailable = message => Object.assign(new Error(message), { code: 'DEVICE_ACCESS_REQUIRED' });

// This state is stored by the native plugin, separately from the ledger and session.
// Reopening, logging out and restoring a ledger must never restart the trial/lease.
export function createDeviceAccess({ vault, now = () => Date.now(), monotonic = () => performance.now() } = {}) {
  let saved = null, ready = false, loading = null, anchor = 0, anchorTick = 0, rollback = false;
  let onlineUntil = 0, storageError = '', saveTail = Promise.resolve();
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
    async initialize() {
      if (ready) return;
      if (loading) return loading;
      loading = (async () => {
        try {
          saved = await vault.load();
          if (!saved) {
            const start = now();
            saved = { trialUntil: start + DEFAULT_OFFLINE_HOURS * HOUR, localTime: start, trustedTime: start, grant: null };
            anchor = start; anchorTick = monotonic();
            await persist();
          } else {
            if (!Number.isFinite(saved.trialUntil) || !Number.isFinite(saved.localTime) || !Number.isFinite(saved.trustedTime)) throw unavailable('设备授权记录损坏，请联网登录');
            rollback = saved.rollback === true || now() < saved.localTime - 5 * 60000;
            anchor = saved.trustedTime + Math.max(0, now() - saved.localTime); anchorTick = monotonic();
          }
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
      saved = { ...(saved || { trialUntil: 0 }), denied: null, localTime: now(), trustedTime: serverTime,
        grant: { ...grant, offlineUntil: Math.min(serverTime + grant.offlineHours * HOUR,
          grant.authorizedUntil ? Date.parse(grant.authorizedUntil) : Infinity) } };
      anchor = serverTime; anchorTick = monotonic(); rollback = false; storageError = '';
      onlineUntil = time() + 60000; ready = true;
      await persist();
    },
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
      else if (saved.denied === 'DEVICE_DISABLED' || grant && !grant.active) reason = '此设备已被管理员禁用，请联系店主';
      else if (saved.denied === 'DEVICE_EXPIRED' || grant?.authorizedUntil && current >= Date.parse(grant.authorizedUntil)) reason = '设备授权已到期，请联系店主续期';
      else if (rollback) reason = '手机时间发生变化，请联网确认使用权限';
      else if (grant) {
        if (!(connected && loggedIn && current < onlineUntil)) {
          if (!grant.offlineHours) reason = '此设备不允许离线使用，请联网登录';
          else if (current >= grant.offlineUntil) reason = '离线使用期限已到，请联网登录';
        }
      } else if (current >= (saved?.trialUntil || 0)) reason = '未登录使用期限已到，请联网登录';
      return { ready, allowed: !reason, reason, offlineHours: grant?.offlineHours ?? DEFAULT_OFFLINE_HOURS,
        offlineUntil: grant?.offlineUntil ?? saved?.trialUntil ?? null,
        disabled: saved?.denied === 'DEVICE_DISABLED', authorizedUntil: grant?.authorizedUntil || null };
    },
    assert(options) { const status = this.snapshot(options); if (!status.allowed) throw unavailable(status.reason); }
  };
}
