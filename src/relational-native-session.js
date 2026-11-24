import { reactive } from 'vue';
import { registerPlugin } from '@capacitor/core';
import { createDeviceAccess } from './device-access.js';
import { canonicalJSON } from './canonical-json.js';
import { normalizeServerUrl } from './server-origin.js';
import { createRelationalRemote } from './relational-remote.js';
import { ledgerEpochOf } from './ledger-epoch.js';
import { COMMAND_ID, ENTITY_ID } from './relational-contract.js';
import { latestStoreProfile, normalizeStoreProfile } from './store-profile.js';

export const cloudDeviceBridge = registerPlugin('CloudDevice');
const fault = (message, code, status = 409) => Object.assign(new Error(message), { code, status });
const sessionChanged = () => fault('手机账号或服务器已变化，请核对原操作', 'AUTH_CONTEXT_CHANGED');
const denied = new Set(['USER_DISABLED', 'STORE_DISABLED', 'DEVICE_DISABLED', 'DEVICE_EXPIRED', 'LICENSE_REQUIRED', 'LICENSE_EXPIRED']);
const validUser = user => typeof user?.storeId === 'string' && ENTITY_ID.test(user.storeId) && typeof user.id === 'string' && ENTITY_ID.test(user.id) && ['owner', 'clerk', 'viewer'].includes(user.role);
const sameUser = (a, b) => a && b && a.id === b.id && a.storeId === b.storeId;
function bookBinding(value) {
  if (!value || typeof value.storeId !== 'string' || !ENTITY_ID.test(value.storeId) || !['cloud', 'standalone'].includes(value.mode) || value.v !== 2) throw fault('本机账本绑定记录无效，须保留账本核对', 'BOOK_BINDING_INVALID');
  return value.mode === 'cloud' ? { v: 2, mode: value.mode, storeId: value.storeId, origin: normalizeServerUrl(value.origin), ledgerEpoch: ledgerEpochOf(value.ledgerEpoch) }
    : { v: 2, mode: value.mode, storeId: value.storeId };
}
function parse(value) { return value ? JSON.parse(value) : null; }

export function createRelationalNativeSession({ device = cloudDeviceBridge,
  fetch: send = (...args) => fetch(...args), isOnline = () => globalThis.navigator?.onLine !== false,
  access = createDeviceAccess({ vault: { async load() { return parse((await device.loadAccess()).access); },
    async save(value) { await device.saveAccess({ access: JSON.stringify(value) }); } } }) } = {}) {
  const state = reactive({ ready: false, user: null, binding: null, deviceId: '', serverUrl: '', online: isOnline(),
    deviceAccess: { allowed: false, features: [] }, storeProfile: normalizeStoreProfile(), syncLoginRequired: true, generation: 0, error: '', busy: false });
  let fingerprint = null, deviceName = '', accessToken = '', refreshToken = '', localId = null, unavailable = false, unsavedSession = false;
  let mutation = null, boot = null, refreshing = null, heartbeat = null;
  let vaultTail = Promise.resolve();
  const serializeVault = action => { const next = vaultTail.then(action); vaultTail = next.catch(() => {}); return next; };
  const network = () => isOnline() && !unavailable;
  const loggedIn = () => Boolean(state.user && (state.binding?.mode === 'cloud' ? refreshToken : localId && localId === access.localLicense()?.id));
  const options = () => ({ connected: network(), loggedIn: loggedIn() });
  const publishAccess = () => { state.online = network(); state.deviceAccess = access.snapshot(options()); };
  const assertCurrent = generation => { if (state.generation !== generation) throw sessionChanged(); };
  const metadata = () => ({ clientKind: 'native', deviceFingerprint: fingerprint, deviceName });
  const refreshPath = '/api/v1/auth/refresh';
  const logoutPath = '/api/v1/auth/logout';
  const asJson = value => ({ method: 'POST', body: JSON.stringify(value) });

  async function exchange(origin, path, token, { signal, ...init } = {}, consume = response => response.json(), timeout = 15000) {
    if (!/^\/api\/v[12]\/[a-z]/.test(path)) throw new Error('无效的服务器请求');
    const stop = new AbortController(), timer = setTimeout(() => stop.abort(), timeout), abort = () => stop.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) throw fault('操作已取消', 'REQUEST_ABORTED');
      const response = await send(origin + path, { ...init, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: stop.signal,
        headers: { ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init.headers, ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
      if (!response.ok) {
        const value = await response.json().catch(() => ({}));
        throw fault(value?.error || '服务器请求失败', value?.code, response.status);
      }
      return await consume(response);
    } catch (error) {
      if (signal?.aborted) throw fault('操作已取消', 'REQUEST_ABORTED');
      if (error.status || error.code) throw error;
      // A transport failure cannot clear authorization or an original request.
      throw Object.assign(new Error('暂时不能连接服务器，本机账本和原待办已保留'), { network: true, cause: error });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function revoked(error, generation) {
    if (generation !== state.generation) return;
    if (error.network) { unavailable = true; publishAccess(); return; }
    if (denied.has(error.code) || error.status === 401) {
      accessToken = ''; refreshToken = ''; unsavedSession = false; state.user = null; state.syncLoginRequired = true; state.generation++;
      const ending = state.generation;
      try { await serializeVault(async () => { assertCurrent(ending); try { await access.deny(error.code || 'AUTH_REQUIRED'); } finally { await device.clearSession(); } }); }
      finally { publishAccess(); }
    }
  }
  function validateGrant(value, binding) {
    if (!validUser(value?.user) || value.user.storeId !== binding.storeId || !sameUser(value.user, value.authorization?.user) ||
      value.authorization.user.role !== value.user.role || value.authorization.deviceId !== state.deviceId) throw sessionChanged();
  }
  async function keepOnline(value, binding, generation, { saveTokens = true } = {}) {
    validateGrant(value, binding);
    if (saveTokens && (typeof value.accessToken !== 'string' || !value.accessToken || typeof value.refreshToken !== 'string' || !value.refreshToken)) throw sessionChanged();
    await serializeVault(async () => {
      assertCurrent(generation);
      await access.accept(value.authorization, state.deviceId);
      assertCurrent(generation);
      if (saveTokens) {
        accessToken = value.accessToken;
        refreshToken = value.refreshToken;
        unsavedSession = true;
      }
      if (unsavedSession) {
        try {
          await device.saveSession({ session: JSON.stringify({ v: 2, mode: 'cloud', origin: binding.origin, deviceId: state.deviceId,
            user: value.user, refreshToken }) });
          unsavedSession = false;
          if (state.error === '本机登录尚未保存，联网后会重试。') state.error = '';
        } catch {
          state.error = '本机登录尚未保存，联网后会重试。';
        }
        assertCurrent(generation);
      }
      localId = null; unavailable = false; state.syncLoginRequired = false;
      state.storeProfile = latestStoreProfile(sameUser(state.user, value.user) ? state.storeProfile : null, value.storeProfile);
      if (state.user && state.user.role !== value.user.role) state.generation++;
      state.user = value.user; publishAccess();
    });
  }
  async function bind(value) {
    const next = bookBinding(value);
    if (state.binding) {
      if (state.binding.mode !== next.mode || state.binding.storeId !== next.storeId || state.binding.origin !== next.origin)
        throw fault('手机已绑定不同门店、服务器或模式。请保留原账本和待办，联系店主核对。', 'BOOK_BINDING_MISMATCH');
      return state.binding;
    }
    await device.saveBookBinding({ binding: canonicalJSON(next) });
    state.binding = next; state.serverUrl = next.origin || ''; return next;
  }
  async function init() {
    if (!boot) boot = (async () => {
      const result = await device.getDeviceId({});
      if (typeof result.deviceId !== 'string' || !COMMAND_ID.test(result.deviceId)) throw new Error('设备标识无效');
      state.deviceId = result.deviceId; fingerprint = result.deviceFingerprint; deviceName = result.deviceName;
      const saved = parse((await device.loadBookBinding()).binding);
      if (saved) { state.binding = bookBinding(saved); state.serverUrl = state.binding.origin || ''; }
      try { await access.initialize(state.deviceId); }
      catch (error) { state.error = error.message; }
      if (state.binding) {
        let cached;
        try { cached = parse((await device.loadSession()).session); } catch (error) { state.error ||= error.message; }
        if (cached?.v === 2 && cached.mode === state.binding.mode && cached.deviceId === state.deviceId && validUser(cached.user) && cached.user.storeId === state.binding.storeId &&
          sameUser(cached.user, access.cachedUser())) {
          if (cached.mode === 'standalone' && cached.localLicenseId === access.localLicense()?.id) localId = cached.localLicenseId;
          if (cached.mode === 'cloud' && cached.origin === state.binding.origin && typeof cached.refreshToken === 'string' && cached.refreshToken) refreshToken = cached.refreshToken;
          if (refreshToken || localId) {
            state.user = access.cachedUser(); state.syncLoginRequired = false;
            if (localId) state.storeProfile = normalizeStoreProfile({ name: access.localLicense().storeName });
          }
        }
      }
      state.ready = true; publishAccess();
    })().catch(error => { state.error = error.message; state.ready = Boolean(state.deviceId && state.binding); boot = null; publishAccess(); throw error; });
    return boot;
  }
  function change(work) {
    if (mutation) return Promise.reject(new Error('账号操作正在进行'));
    state.busy = true; state.error = ''; state.generation++;
    mutation = Promise.resolve().then(work).finally(() => { mutation = null; state.busy = false; publishAccess(); });
    return mutation;
  }
  async function refresh(previous) {
    if (previous && accessToken && accessToken !== previous) return;
    if (refreshing) return refreshing;
    const generation = state.generation, binding = state.binding, original = state.user, token = refreshToken;
    if (mutation || !token || binding?.mode !== 'cloud' || !original) throw fault('请先登录原云端账号', 'AUTH_REQUIRED', 401);
    refreshing = (async () => {
      try {
        const value = await exchange(binding.origin, refreshPath, '', asJson({ refreshToken: token, ...metadata() }));
        assertCurrent(generation); if (!sameUser(original, value.user)) throw sessionChanged();
        try { await keepOnline(value, binding, generation); }
        catch (error) { assertCurrent(generation); throw error; }
      } catch (error) { await revoked(error, generation); throw error; }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function requestStream(path, consume, init = {}, timeout) {
    const original = state.user, binding = state.binding, initial = state.generation;
    if (!original || binding?.mode !== 'cloud' || mutation) throw fault('请登录云端账号', 'ONLINE_REQUIRED', 401);
    const same = () => { if (!sameUser(original, state.user) || state.binding !== binding) throw sessionChanged(); };
    if (!accessToken) { await refresh(); same(); }
    assertCurrent(initial);
    const captured = state.generation, previous = accessToken;
    const run = async () => {
      try {
        const value = await exchange(binding.origin, path, accessToken, init, async response => {
          same(); assertCurrent(captured);
          return consume ? consume(response, () => { same(); assertCurrent(captured); }) : response.json();
        }, timeout);
        same(); assertCurrent(captured); unavailable = false; publishAccess(); return value;
      } catch (error) { if (error.network || denied.has(error.code)) await revoked(error, captured); throw error; }
    };
    try { return await run(); }
    catch (error) {
      if (error.status !== 401) throw error;
      assertCurrent(captured); await refresh(previous); assertCurrent(captured); same();
      try { return await run(); } catch (cause) { if (cause.status === 401) await revoked(cause, captured); throw cause; }
    }
  }
  const request = (path, init) => requestStream(path, undefined, init);
  const remote = createRelationalRemote({ request });
  const session = {
    state, init, request, requestStream, remote, publishAccess,
    authorize({ storeId, mode }) {
      if (mutation || state.binding?.mode !== mode || state.binding?.storeId !== storeId || !loggedIn()) throw sessionChanged();
      access.assert(options());
      return { ...state.user, deviceId: state.deviceId, features: access.snapshot(options()).features, contextVersion: state.generation };
    },
    async login(origin, username, password) {
      await init();
      return change(async () => {
        if (state.user) throw fault('请先退出当前账号', 'AUTH_CONTEXT_CHANGED');
        const generation = state.generation; origin = normalizeServerUrl(origin);
        if (state.binding && (state.binding.mode !== 'cloud' || state.binding.origin !== origin)) throw fault('手机已绑定其他服务器或独立离线账本', 'BOOK_BINDING_MISMATCH');
        const value = await exchange(origin, '/api/v1/auth/login', '', asJson({ username, password, deviceId: state.deviceId, ...metadata() }));
        try {
          if (!validUser(value?.user) || state.binding && value.user.storeId !== state.binding.storeId) throw fault('此账号不属于本机账本门店', 'BOOK_BINDING_MISMATCH');
          const lookup = createRelationalRemote({ request: path => exchange(origin, path, value.accessToken) });
          const book = await lookup.getBook();
          if (book.storeId !== value.user.storeId) throw sessionChanged();
          validateGrant(value, { storeId: book.storeId });
          const binding = await bind({ v: 2, mode: 'cloud', ...book, origin });
          await keepOnline(value, binding, generation);
        } catch (error) { if (value?.accessToken) await exchange(origin, logoutPath, value.accessToken, asJson({})).catch(() => {}); throw error; }
      });
    },
    async activateOffline(code, password) {
      await init();
      return change(async () => {
        if (state.user || state.binding?.mode === 'cloud') throw fault('退出当前账号后才能激活；不能将云端账本改为独立离线', 'BOOK_BINDING_MISMATCH');
        const inspected = await access.inspectOffline(code, state.deviceId);
        if (state.binding && state.binding.storeId !== inspected.storeId) throw fault('离线许可与当前账本门店不同', 'BOOK_BINDING_MISMATCH');
        const claims = await access.activateOffline(code, password, state.deviceId);
        await bind({ v: 2, mode: 'standalone', storeId: claims.storeId }); await keepOffline(claims);
      });
    },
    async loginOffline(username, password) {
      await init();
      return change(async () => {
        if (state.user || state.binding?.mode !== 'standalone') throw fault('请先激活本机独立离线许可', 'OFFLINE_ONLY');
        await keepOffline(await access.loginOffline(username, password));
      });
    },
    async logout() {
      return change(async () => {
        const previous = accessToken, saved = refreshToken, origin = state.binding?.origin;
        accessToken = ''; refreshToken = ''; unsavedSession = false; localId = null; state.user = null; state.syncLoginRequired = true;
        state.storeProfile = normalizeStoreProfile(); access.disconnect(); publishAccess();
        await serializeVault(() => device.clearSession());
        if (!isOnline() || !origin || !saved && !previous) return;
        const renew = async () => (await exchange(origin, refreshPath, '', asJson({ refreshToken: saved, ...metadata() }))).accessToken;
        try {
          try { await exchange(origin, logoutPath, previous || await renew(), asJson({})); }
          catch (error) { if (error.status !== 401 || !previous || !saved) throw error; await exchange(origin, logoutPath, await renew(), asJson({})); }
        } catch (error) { if (error.status !== 401) throw error; }
      });
    },
    async heartbeat() {
      if (heartbeat) return heartbeat;
      if (!isOnline()) { unavailable = true; publishAccess(); return; }
      if (state.binding?.mode !== 'cloud' || !state.user || mutation) { publishAccess(); return; }
      const generation = state.generation, original = state.user;
      heartbeat = (async () => {
        const value = await request('/api/v1/device/authorization');
        assertCurrent(generation); if (!sameUser(original, value.user)) throw sessionChanged();
        await keepOnline(value, state.binding, generation, { saveTokens: false });
      })().finally(() => { heartbeat = null; });
      return heartbeat;
    },
    async checkpoint() { await access.checkpoint(); publishAccess(); },
    async downloadAuthorization() { if (!state.user || !isOnline()) throw fault('请联网登录后下载更新', 'ONLINE_REQUIRED'); await refresh(); return accessToken; },
    async loadStoreProfile() {
      if (state.binding?.mode === 'standalone') return state.storeProfile;
      const result = await request('/api/v1/store/profile'); state.storeProfile = latestStoreProfile(state.storeProfile, result); return state.storeProfile;
    },
    async saveStoreProfile(profile, expectedVersion) {
      const result = await request('/api/v1/store/profile', { method: 'PATCH', body: JSON.stringify({ profile, expectedVersion }) });
      state.storeProfile = latestStoreProfile(state.storeProfile, result); return state.storeProfile;
    },
    getVoiceConfig: () => request('/api/v1/voice/config'), getUsers: () => request('/api/v1/users'),
    getAliGenieDevices: () => request('/api/v1/voice/aligenie/devices'),
    saveVoiceConfig: (config, expectedVersion) => request('/api/v1/voice/config', asJson({ ...config, expectedVersion })),
    synthesizeVoice(options, { signal } = {}) {
      return requestStream('/api/v1/voice/synthesize', async response => {
        const audio = await response.blob();
        if (!audio.size || audio.size > 8 * 1024 * 1024 || !/^audio\//i.test(audio.type)) throw new Error('语音服务未返回有效音频');
        return audio;
      }, { ...asJson(options), signal }, 130000);
    }
  };
  async function keepOffline(claims) {
    const user = { ...claims.user, storeId: claims.storeId };
    if (!validUser(user) || state.binding?.mode !== 'standalone' || user.storeId !== state.binding.storeId) throw sessionChanged();
    await serializeVault(() => device.saveSession({ session: JSON.stringify({ v: 2, mode: 'standalone', localLicenseId: claims.id, user, deviceId: state.deviceId }) }));
    localId = claims.id; state.user = user; state.syncLoginRequired = false; state.storeProfile = normalizeStoreProfile({ name: claims.storeName }); publishAccess();
  }
  return session;
}
