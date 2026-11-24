import { ref, customRef } from 'vue';
import { withBrowserLock } from '../utils/browser-lock.js';
import { latestStoreProfile, DEFAULT_STORE_PROFILE } from '../../../src/store-profile.js';

export const ADMIN_SESSION_KEY = 'hairstudio_admin_auth';
const STORAGE_KEY = ADMIN_SESSION_KEY;
export const ADMIN_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const identityKey = user => user ? user.storeId + ':' + user.id : '';
const sessionError = () => Object.assign(new Error('登录账号已变化，请重新加载账本'), { status: 401, code: 'SESSION_CHANGED' });

const memoryStorage = () => {
  const map = new Map();
  return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
};

export class MerchantSessionClient {
  constructor({ storage = globalThis.localStorage || memoryStorage(), fetch: requestFetch = (...args) => fetch(...args),
    locks, indexedDB, serverOrigin = globalThis.location?.origin || 'same-origin', eventTarget = globalThis.window } = {}) {
    this.serverOrigin = serverOrigin;
    this.storage = storage; this.requestFetch = requestFetch; this.lockOptions = { locks, indexedDB };
    this.accessToken = ref(''); this.refreshToken = ref(''); this.user = ref(null); this.entitlements = ref(null);
    this.storeProfile = ref({ ...DEFAULT_STORE_PROFILE }); this.idleExpiresAt = ref(null);
    this.generation = 0; this.applyingSession = false; this.refreshPromise = null; this.lockSignals = new Set();
    this.deviceId = this.getOrCreateDeviceId(); this.autoLock = true; this.isLocked = this.createLockedRef(); this.restoreSession();
    const changed = event => { if (event.key === STORAGE_KEY || event.key === null) this.restoreSession(); };
    eventTarget?.addEventListener('storage', changed);
    this.dispose = () => eventTarget?.removeEventListener('storage', changed);
  }

  lock(name, callback) {
    return withBrowserLock('hairstudio-admin-' + name, async signal => {
      if (signal) this.lockSignals.add(signal);
      try { return await callback(); } finally { if (signal) this.lockSignals.delete(signal); }
    }, this.lockOptions);
  }
  readSavedSession() {
    const raw = this.storage.getItem(STORAGE_KEY);
    try { return raw ? JSON.parse(raw) : null; } catch { return null; }
  }

  createLockedRef() {
    return customRef((track, trigger) => {
      let value = false;
      return {
        get() { track(); return value; },
        set: newValue => {
          const next = Boolean(newValue);
          if (next !== value) { value = next; trigger(); }
          if (this.applyingSession || !this.user.value) return;
          const saved = this.readSavedSession();
          if (identityKey(saved?.user) === identityKey(this.user.value)) {
            const idleExpiresAt = value ? saved.idleExpiresAt : Date.now() + ADMIN_IDLE_TIMEOUT_MS;
            this.idleExpiresAt.value = idleExpiresAt;
            this.storage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, isLocked: value, idleExpiresAt }));
          }
        }
      };
    });
  }

  getOrCreateDeviceId() {
    let id = this.storage.getItem('hairstudio_device_id');
    if (!id) { id = 'pc-admin-' + globalThis.crypto.randomUUID(); this.storage.setItem('hairstudio_device_id', id); }
    return id;
  }

  applySession(data) {
    const sameIdentity = identityKey(data?.user) === identityKey(this.user.value);
    if (identityKey(data?.user) !== identityKey(this.user.value)) {
      this.generation++;
    }
    this.accessToken.value = data?.accessToken || ''; this.refreshToken.value = data?.refreshToken || '';
    this.user.value = data?.user || null;
    this.entitlements.value = data?.entitlements || null;
    this.storeProfile.value = data?.user ? (data.storeProfile ? latestStoreProfile(sameIdentity ? this.storeProfile.value : null, data.storeProfile) : sameIdentity ? this.storeProfile.value : { ...DEFAULT_STORE_PROFILE }) : { ...DEFAULT_STORE_PROFILE };
    this.idleExpiresAt.value = data?.idleExpiresAt ?? null;
    this.applyingSession = true;
    try { this.isLocked.value = Boolean(data?.isLocked); } finally { this.applyingSession = false; }
  }

  setAutoLock(enabled) {
    this.autoLock = Boolean(enabled);
    if (!this.autoLock && this.isLocked.value) {
      this.isLocked.value = false;
    }
  }

  restoreSession() {
    try {
      let saved = this.readSavedSession();
      // Legacy sessions have no trusted activity deadline and must be unlocked once.
      if (this.autoLock !== false && saved?.user && !saved.isLocked && (!Number.isSafeInteger(saved.idleExpiresAt) || saved.idleExpiresAt <= Date.now())) {
        saved = { ...saved, isLocked: true };
        this.storage.setItem(STORAGE_KEY, JSON.stringify(saved));
      }
      this.applySession(saved);
    } catch { this.applySession(null); }
  }

  saveSession(data, isLocked = this.isLocked.value, { resetIdle = false } = {}) {
    const saved = this.readSavedSession();
    const idleExpiresAt = resetIdle || identityKey(saved?.user) !== identityKey(data.user)
      ? Date.now() + ADMIN_IDLE_TIMEOUT_MS : saved?.idleExpiresAt;
    const currentProfile = identityKey(saved?.user) === identityKey(data.user) ? saved?.storeProfile : null;
    const storeProfile = data.storeProfile ? latestStoreProfile(currentProfile, data.storeProfile) : currentProfile || { ...DEFAULT_STORE_PROFILE };
    this.storage.setItem(STORAGE_KEY, JSON.stringify({ ...data, storeProfile, isLocked, idleExpiresAt }));
    this.restoreSession();
  }

  recordActivity() {
    // Check expiry before recording input so resuming an idle tab cannot unlock it.
    this.restoreSession();
    if (!this.user.value || this.isLocked.value) return false;
    const saved = this.readSavedSession();
    const deadline = Date.now() + ADMIN_IDLE_TIMEOUT_MS;
    // Pointer movement can fire many times per frame. Share activity at most
    // once a second; always check the persisted lock before extending it.
    if (deadline - saved.idleExpiresAt < 1000) return false;
    const next = { ...saved, idleExpiresAt: deadline };
    this.storage.setItem(STORAGE_KEY, JSON.stringify(next));
    this.applySession(next);
    return true;
  }

  clearSession() { this.applySession(null); this.storage.removeItem(STORAGE_KEY); }

  assertSession(generation) {
    if ([...this.lockSignals].some(signal => signal.aborted)) throw new Error('安全同步锁失效，请重试原操作');
    this.restoreSession();
    if (generation !== this.generation || !this.user.value) throw sessionError();
  }

  async exchange(path, options = {}, consume = response => response.json(), timeout = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('请求等待超时'), { code: 'REQUEST_TIMEOUT' })), timeout);
    const signals = [...this.lockSignals, options.signal].filter(Boolean), abort = () => controller.abort();
    for (const signal of signals) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }
    try {
      const response = await this.requestFetch(path, { ...options, signal: controller.signal, cache: 'no-store', redirect: 'error' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw Object.assign(new Error(data.error || '请求失败 (' + response.status + ')'), {
          status: response.status, code: data.code,
          ...(response.status === 429 ? { retryAfter: Math.min(60, Math.max(1, Number(response.headers.get('Retry-After')) || 60)) } : {})
        });
      }
      return await consume(response);
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally { clearTimeout(timer); for (const signal of signals) signal.removeEventListener('abort', abort); }
  }
  fetchJSON(path, options) { return this.exchange(path, options); }
  request(path, options = {}) { return this.requestStream(path, undefined, options, 15000); }
  async requestStream(path, consume, options = {}, timeout = 10 * 60000 + 15000) {
    this.restoreSession();
    const generation = this.generation, previousAccess = this.accessToken.value;
    const assertUnlocked = () => { this.assertSession(generation); if (this.isLocked.value) throw Object.assign(new Error('请先解锁'), { code: 'SESSION_LOCKED' }); };
    const send = token => this.exchange(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}) } }, async response => {
      assertUnlocked(); return consume ? consume(response, assertUnlocked) : response.json();
    }, timeout);
    try {
      assertUnlocked(); let value;
      try { value = await send(previousAccess); }
      catch (error) {
        if (error.status !== 401 || path.startsWith('/api/v1/auth/')) throw error;
        assertUnlocked();
        if (!await this.refresh(previousAccess)) throw Object.assign(new Error('登录会话已过期，请重新登录'), { status: 401 });
        assertUnlocked(); value = await send(this.accessToken.value);
      }
      assertUnlocked(); return value;
    } catch (error) {
      this.restoreSession();
      if ((error.status === 401 || ['STORE_DISABLED', 'USER_DISABLED', 'LICENSE_REQUIRED', 'LICENSE_EXPIRED'].includes(error.code)) && this.generation === generation) this.clearSession();
      throw error;
    }
  }
  async synthesizeVoice(options, { signal } = {}) {
    try { return await this.requestStream('/api/v1/voice/synthesize', async response => {
      const data = await response.blob();
      if (!data.size || data.size > 8 * 1024 * 1024 || !/^audio\//i.test(data.type)) throw new Error('语音服务未返回有效音频');
      return data;
    }, { method: 'POST', body: JSON.stringify(options), signal }, 130000); }
    catch (error) {
      if (signal?.aborted && error.name === 'AbortError') throw Object.assign(new Error('播报已取消'), { code: 'VOICE_CANCELLED' });
      if (error.code === 'REQUEST_TIMEOUT') throw Object.assign(new Error('语音合成等待超时，请稍后重试'), { code: 'VOICE_TIMEOUT' });
      throw error;
    }
  }

  async login(username, password) {
    return this.lock('auth', async () => {
      const data = await this.fetchJSON('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, deviceId: this.deviceId }) });
      this.saveSession(data, false, { resetIdle: true });
      return data;
    });
  }

  async refresh(previousAccess = this.accessToken.value) {
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.generation;
    this.refreshPromise = this.lock('auth', async () => {
      this.assertSession(generation);
      // Another tab can rotate the shared tokens while this tab waits for the lock.
      if (this.accessToken.value !== previousAccess) return true;
      if (!this.refreshToken.value) { this.clearSession(); return false; }
      try {
        const data = await this.fetchJSON('/api/v1/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: this.refreshToken.value }) });
        this.assertSession(generation); this.saveSession(data); return true;
      } catch (error) {
        if (error.status === 401 && this.generation === generation) { this.clearSession(); return false; }
        throw error;
      }
    }).finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  async logout() {
    return this.lock('auth', async () => {
      this.restoreSession();
      const access = this.accessToken.value, refresh = this.refreshToken.value;
      this.clearSession();
      const revoke = token => this.fetchJSON('/api/v1/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
      try {
        if (access) await revoke(access);
        else if (refresh) throw Object.assign(new Error('需要刷新会话'), { status: 401 });
      } catch (error) {
        if (error.status !== 401 || !refresh) throw error;
        const next = await this.fetchJSON('/api/v1/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: refresh }) });
        await revoke(next.accessToken);
      }
    });
  }

  getUsers() { return this.request('/api/v1/users'); }
  keepStoreProfile(profile) {
    this.storeProfile.value = latestStoreProfile(this.storeProfile.value, profile);
    const saved = this.readSavedSession();
    if (saved && identityKey(saved.user) === identityKey(this.user.value)) this.storage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, storeProfile: this.storeProfile.value }));
  }
  async loadStoreProfile() {
    const profile = await this.request('/api/v1/store/profile');
    this.keepStoreProfile(profile); return this.storeProfile.value;
  }
  async saveStoreProfile(profile, expectedVersion) {
    const saved = await this.request('/api/v1/store/profile', { method: 'PATCH', body: JSON.stringify({ profile, expectedVersion }) });
    this.keepStoreProfile(saved); return this.storeProfile.value;
  }
  getDevices() { return this.request('/api/v1/devices'); }
  updateDevice(id, payload) { return this.request('/api/v1/devices/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(payload) }); }
  createUser(payload) { return this.request('/api/v1/users', { method: 'POST', body: JSON.stringify(payload) }); }
  updateUser(id, payload) { return this.request('/api/v1/users/' + id, { method: 'PATCH', body: JSON.stringify(payload) }); }
  getActivity({ before, limit = 100 } = {}) {
    const query = new URLSearchParams({ limit: String(limit), ...(before ? { before: String(before) } : {}) });
    return this.request('/api/v1/activity?' + query);
  }
  async getAllActivity(onProgress = () => {}) {
    this.restoreSession(); const generation = this.generation;
    const rows = []; let before;
    for (;;) {
      let page;
      try { page = await this.getActivity({ before, limit: 500 }); }
      catch (error) {
        if (error.status !== 429) throw error;
        this.assertSession(generation);
        await new Promise(resolve => setTimeout(resolve, 1000 * (error.retryAfter || 60)));
        this.assertSession(generation);
        continue;
      }
      this.assertSession(generation);
      if (!Array.isArray(page) || page.some(row => !/^\d+$/.test(String(row.id)) || before && BigInt(row.id) >= BigInt(before))) throw new Error('审计日志分页异常');
      rows.push(...page); onProgress(rows.length);
      if (page.length < 500) return rows;
      before = String(page.at(-1).id);
    }
  }

  identity() { return { ...this.user.value, deviceId: this.deviceId }; }

  async getVoiceConfig() {
    return this.request('/api/v1/voice/config');
  }

  async getAliGenieDevices() {
    return this.request('/api/v1/voice/aligenie/devices');
  }

  async saveVoiceConfig(config, expectedVersion) {
    return this.request('/api/v1/voice/config', {
      method: 'POST',
      body: JSON.stringify({ ...config, expectedVersion })
    });
  }

}
