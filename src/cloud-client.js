import { localDb, DEFAULT_SERVICES, DEFAULT_RECHARGE_PLANS } from './storage.js';
import { getCloudState, saveCloudState, installCloudRecording, replayOperation } from './cloud-storage.js';
import { CLOUD_STATE_KEY, canonicalJSON, newId, canWrite, mutationPrecondition, validateOperation, selectSyncBatch } from './sync-protocol.js';

export function normalizeServerUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('请填写服务器域名，例如 https://member.example.com');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('云端连接必须使用 HTTPS');
  return url.origin;
}
export async function sha256(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createCloudClient({ fetch: requestFetch = (...args) => fetch(...args),
  vault = { load: async () => null, save: async () => {}, clear: async () => {} },
  isOnline = () => globalThis.navigator?.onLine !== false, allowOffline = false,
  onData = () => {}, clock = () => new Date().toISOString() } = {}) {
  let accessToken = '', refreshToken = '', busy = false, lastError = '', refreshPromise = null;
  let restorePromise = null, networkUnavailable = false;
  const offlineEnabled = () => typeof allowOffline === 'function' ? allowOffline() : allowOffline;
  const listeners = new Set();
  const emit = () => { for (const listener of listeners) listener(client.snapshot()); };
  const setState = state => { saveCloudState(state); emit(); };

  async function raw(path, body, authorization = accessToken, method = body === undefined ? 'GET' : 'POST') {
    const state = getCloudState();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await requestFetch(state.serverUrl + '/api/v1' + path, {
        method, headers: { ...(authorization ? { Authorization: 'Bearer ' + authorization } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error'
      });
      const result = await response.json();
      networkUnavailable = false;
      if (!response.ok) { const error = new Error(result.error || '云端请求失败'); error.status = response.status; error.code = result.code; throw error; }
      return result;
    } catch (error) {
      if (!error.status) { networkUnavailable = true; const network = new Error('暂时无法连接服务器，仍可离线使用；本机账本和待同步记录已保留'); network.network = true; throw network; }
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function keepSession(session) {
    accessToken = session.accessToken; refreshToken = session.refreshToken;
    const state = getCloudState();
    await vault.save({ refreshToken, serverUrl: state.serverUrl, userId: session.user.id, storeId: session.user.storeId });
    // 原生安全存储是异步的，期间新增的记账操作必须保留。
    const current = getCloudState();
    const forbidden = current.outbox.some(operation => !canWrite(session.user.role, operation.method)) ||
      (current.bootstrap && session.user.role !== 'owner');
    let status = current.status, conflictReason = current.conflictReason;
    if (forbidden) { status = 'conflict'; if (conflictReason !== 'recovery') conflictReason = 'permissions'; }
    else if (status === 'login-required' || conflictReason === 'permissions') {
      if (conflictReason === 'permissions') conflictReason = null;
      status = conflictReason ? 'conflict' : current.bootstrap || current.outbox.length ? 'pending' : current.binding ? 'synced' : 'local';
    }
    setState({ ...current, user: session.user, syncLoginRequired: false, status, conflictReason });
  }
  async function invalidateSession() {
    accessToken = ''; refreshToken = '';
    const state = getCloudState();
    // App 的缓存身份用于离线记账；失效的云端令牌不能再用于同步。
    // 网页仍必须重新登录，主动退出登录也会清除身份。
    setState({ ...state, user: offlineEnabled() ? state.user : null, syncLoginRequired: true,
      status: offlineEnabled() && state.status === 'conflict' ? 'conflict' : 'login-required' });
    await vault.clear();
  }
  async function refreshSession() {
    if (!refreshPromise) refreshPromise = (async () => {
      try {
        if (!refreshToken) throw Object.assign(new Error('请重新登录后同步，本机账本和待同步记录已保留'), { status: 401 });
        await keepSession(await raw('/auth/refresh', { refreshToken }, ''));
      } catch (error) {
        if (error.status === 401) await invalidateSession();
        throw error;
      }
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }
  async function request(path, body, method) {
    if (offlineEnabled() && !accessToken && !refreshToken) await client.restoreSession();
    if (!accessToken) await refreshSession();
    try { return await raw(path, body, accessToken, method); }
    catch (error) { if (error.status !== 401) throw error; await refreshSession(); return raw(path, body, accessToken, method); }
  }
  async function verifyAccount(account) {
    if (!account || !Number.isSafeInteger(account.revision) || account.revision < 0 ||
      typeof account.integrity !== 'string' || await sha256(canonicalJSON(account.data)) !== account.integrity) throw new Error('收到的云端账本校验失败，本机数据未覆盖');
    account.data = localDb.parseAndValidateBackup(JSON.stringify({ data: account.data })).data;
    return account;
  }
  async function accept(account, acknowledged = []) {
    await verifyAccount(account);
    const state = getCloudState();
    if (account.revision < state.revision) throw new Error('云端版本发生回退，本机数据未覆盖');
    const ids = new Set(acknowledged);
    const pending = state.outbox.filter(operation => !ids.has(operation.id));
    let data = account.data;
    try { for (const operation of pending) data = replayOperation(data, operation).data; }
    catch (error) {
      setState({ ...state, revision: account.revision, outbox: pending, remoteConflict: account, status: 'conflict' });
      throw error;
    }
    localDb.applyCloudSnapshot(data, CLOUD_STATE_KEY, { ...state, revision: account.revision, outbox: pending, bootstrap: null,
      remoteConflict: null, conflictReason: null, status: pending.length ? 'pending' : 'synced', lastSync: clock() });
    onData(); emit();
  }
  async function run(callback) {
    if (busy) return;
    busy = true; lastError = ''; emit();
    try { return await callback(); }
    catch (error) { lastError = error.message; emit(); throw error; }
    finally { busy = false; emit(); }
  }
  async function flushActivity() {
    const state = getCloudState();
    const events = state.activity.filter(event => event.actorId === state.user?.id && event.deviceId === state.deviceId).slice(0, 100);
    if (!events.length) return;
    await request('/activity', { events });
    const ids = new Set(events.map(event => event.id));
    setState({ ...getCloudState(), activity: getCloudState().activity.filter(event => !ids.has(event.id)) });
  }

  async function sendOperations(path, body) {
    try { return await request(path, body); }
    catch (error) {
      if (error.code === 'SYNC_CONFLICT' || error.status === 403) {
        const state = getCloudState();
        const reason = state.conflictReason === 'recovery' ? 'recovery' : error.status === 403 ? 'permissions' :
          path === '/account/bootstrap' ? 'bootstrap' : 'data';
        // 先显示处理入口，查询远端失败也不能让待办重新陷入自动重试。
        setState({ ...state, status: 'conflict', conflictReason: reason, remoteConflict: null });
        try {
          const remote = await verifyAccount(await request('/account'));
          setState({ ...getCloudState(), remoteConflict: remote });
        } catch { /* 本机账本和待办已保留，处理时会重新校验云端账本。 */ }
      }
      throw error;
    }
  }

  function preserveLocal(state) {
    const safety = { createdAt: clock(), ...localDb.readRecoveryState(), cloud: state };
    localStorage.setItem('hairstudio_cloud_pre_replace_v1', JSON.stringify(safety));
  }

  const client = {
    snapshot() { try { return { ...getCloudState(), busy, online: isOnline() && !networkUnavailable, error: lastError }; } catch (error) { return { status: 'error', outbox: [], activity: [], busy, error: error.message }; } },
    subscribe(listener) { listeners.add(listener); listener(this.snapshot()); return () => listeners.delete(listener); },
    async login(serverUrl, username, password, { autoBootstrap = false } = {}) {
      return run(async () => {
        const old = getCloudState(); serverUrl = normalizeServerUrl(serverUrl);
        if (old.binding && old.serverUrl !== serverUrl) throw new Error('本机已绑定另一服务器，请先备份并解除绑定');
        setState({ ...old, serverUrl, deviceId: old.deviceId || newId() });
        const session = await raw('/auth/login', { username, password, deviceId: getCloudState().deviceId }, '');
        const current = getCloudState();
        if ((current.binding && current.binding.storeId !== session.user.storeId) || current.outbox.some(op => op.actorId !== session.user.id)) {
          await raw('/auth/logout', {}, session.accessToken);
          throw new Error('本机绑定的门店或未同步记录所属账号不同，请使用原账号登录');
        }
        await keepSession(session);
        const remote = await verifyAccount(await request('/account'));
        if (old.binding) return;
        const local = localDb.readRecoveryState().data;
        if (!local) { setState({ ...getCloudState(), status: 'needs-choice' }); return; }
        if (autoBootstrap && session.user.role === 'owner' && remote.revision === 0 &&
            !remote.data.members.length && !remote.data.ledgers.length) {
          setState({ ...getCloudState(), status: 'needs-bootstrap' });
          return;
        }
        const hasCustomSettings = canonicalJSON(local.services) !== canonicalJSON(DEFAULT_SERVICES) ||
          canonicalJSON(local.rechargePlans) !== canonicalJSON(DEFAULT_RECHARGE_PLANS);
        if (!local.members.length && !local.ledgers.length && !hasCustomSettings) {
          setState({ ...getCloudState(), binding: { storeId: session.user.storeId }, status: 'synced' });
          await accept(remote);
        } else {
          setState({ ...getCloudState(), status: remote.revision === 0 && !remote.data.members.length && session.user.role === 'owner' ? 'needs-bootstrap' : 'needs-choice' });
        }
      });
    },
    async restoreSession() {
      if (restorePromise) return restorePromise;
      restorePromise = (async () => {
        const state = getCloudState();
        if (!state.serverUrl || !state.user) return;
        let saved;
        try { saved = await vault.load(); }
        catch (error) { if (!offlineEnabled()) throw error; }
        // 读取期间可能主动退出或更换账号，不能恢复旧会话。
        const current = getCloudState();
        if (current.user?.id !== state.user.id || current.serverUrl !== state.serverUrl) return;
        if (saved && saved.serverUrl === state.serverUrl && (!state.binding || saved.storeId === state.binding.storeId) &&
            (!saved.userId || saved.userId === state.user.id) && typeof saved.refreshToken === 'string' && saved.refreshToken) {
          refreshToken = saved.refreshToken;
          if (current.syncLoginRequired) setState({ ...current, syncLoginRequired: false });
        }
        if (!accessToken && !refreshToken) {
          if (!offlineEnabled()) { await invalidateSession(); return; }
          setState({ ...current, syncLoginRequired: true });
        }
        emit();
      })().finally(() => { restorePromise = null; });
      return restorePromise;
    },
    async bootstrap() {
      return run(async () => {
        const state = getCloudState();
        if (state.user?.role !== 'owner') throw new Error('仅店主可以迁移初始账本');
        const bootstrap = state.bootstrap || { id: newId(), data: localDb.readBackupState() };
        setState({ ...state, binding: { storeId: state.user.storeId }, bootstrap, status: 'pending' });
        await accept(await sendOperations('/account/bootstrap', bootstrap), []);
      });
    },
    async sync() {
      if (offlineEnabled() && !accessToken && !refreshToken) {
        await this.restoreSession();
        if (!accessToken && !refreshToken) return;
      }
      const state = getCloudState();
      if (!state.binding || !state.user || !state.serverUrl || !isOnline() || state.status === 'conflict' || busy) return;
      return run(async () => {
        if (getCloudState().bootstrap) await accept(await sendOperations('/account/bootstrap', getCloudState().bootstrap));
        for (let count = 0; count < 10; count++) {
          const operations = selectSyncBatch(getCloudState().outbox);
          if (!operations.length) break;
          const response = await sendOperations('/sync', { operations });
          if (canonicalJSON(response.acknowledged) !== canonicalJSON(operations.map(operation => operation.id))) throw new Error('云端确认单号不匹配，待同步记录已保留');
          await accept(response, response.acknowledged);
        }
        const head = await request('/account/head');
        if (head.revision > getCloudState().revision) await accept(await request('/account'));
        await flushActivity();
      });
    },
    async useCloudLedger() {
      return run(async () => {
        if (!getCloudState().user) throw new Error('请先登录');
        const remote = await verifyAccount(await request('/account'));
        const state = getCloudState();
        // 保留覆盖前的完整本机账本与待同步记录，便于核对；不是自动覆盖路径。
        if (remote.revision < state.revision) throw new Error('云端版本发生回退，不能替换本机账本');
        preserveLocal(state);
        localDb.applyCloudSnapshot(remote.data, CLOUD_STATE_KEY, { ...state, binding: { storeId: state.user.storeId },
          outbox: [], bootstrap: null, status: 'synced', revision: remote.revision, lastSync: clock(), remoteConflict: null, conflictReason: null }, { allowRecovery: true });
        onData(); emit();
        this.recordConnection('sync_conflict_resolved');
      });
    },
    async uploadRecoveredLedger() {
      return run(async () => {
        const initial = getCloudState();
        if (initial.user?.role !== 'owner' || initial.status !== 'conflict' || initial.conflictReason !== 'recovery') throw new Error('仅店主可以确认上传已恢复的本机账本；已上传的恢复操作请通过同步重试');
        if (!isOnline()) throw new Error('请联网后上传恢复账本');
        const remote = await verifyAccount(await request('/account'));
        const state = getCloudState();
        if (state.user?.role !== 'owner' || state.conflictReason !== 'recovery') throw new Error('账号权限已变化，恢复账本尚未上传');
        if (remote.revision < state.revision) throw new Error('云端版本发生回退，不能上传恢复账本');
        const data = localDb.readBackupState();
        const args = [JSON.stringify({ data }), { mode: 'replace' }];
        const operation = { id: newId(), method: 'importBackupData', args,
          actorId: state.user.id, deviceId: state.deviceId, generated: { ids: [], times: [clock()] },
          precondition: mutationPrecondition(remote.data, 'importBackupData', args) };
        validateOperation(operation);
        preserveLocal(state);
        // 店主确认完整恢复后，用一个可重试的恢复操作替代已归档的原待办。
        localDb.applyCloudSnapshot(data, CLOUD_STATE_KEY, { ...state, outbox: [operation], bootstrap: null,
          remoteConflict: null, revision: remote.revision, status: 'pending' });
        const response = await sendOperations('/sync', { operations: [operation] });
        if (canonicalJSON(response.acknowledged) !== canonicalJSON([operation.id])) throw new Error('云端确认单号不匹配，恢复操作已保留');
        await accept(response, response.acknowledged);
      });
    },
    async logout() {
      if (busy || refreshPromise) throw new Error('请等待当前同步完成');
      return run(async () => {
        const previousAccess = accessToken, previousRefresh = refreshToken;
        setState({ ...getCloudState(), user: null, syncLoginRequired: true, status: 'login-required' });
        accessToken = ''; refreshToken = '';
        await vault.clear();
        // 撤销过期会话时也不能通过 keepSession 恢复本机登录状态。
        try {
          let authorization = previousAccess;
          if (!authorization && previousRefresh) authorization = (await raw('/auth/refresh', { refreshToken: previousRefresh }, '')).accessToken;
          if (authorization) {
            try { await raw('/auth/logout', {}, authorization); }
            catch (error) {
              if (error.status !== 401 || !previousRefresh) throw error;
              authorization = (await raw('/auth/refresh', { refreshToken: previousRefresh }, '')).accessToken;
              await raw('/auth/logout', {}, authorization);
            }
          }
        } catch (error) { if (!error.network && error.status !== 401) throw error; }
      });
    },
    async unlink() {
      if (busy || getCloudState().outbox.length || getCloudState().bootstrap) throw new Error('请先同步待办记录，才能解除绑定');
      await this.logout();
      setState({ ...getCloudState(), binding: null, serverUrl: '', user: null, revision: 0, status: 'local', conflictReason: null, remoteConflict: null });
    },
    recordConnection(type) {
      const state = getCloudState();
      if (!state.binding || !state.user) return;
      setState({ ...state, activity: [...state.activity, { id: newId(), type, at: clock(), actorId: state.user.id, deviceId: state.deviceId }] });
    },
    request,
    async downloadAuthorization() { await refreshSession(); return accessToken; },
    async start() {
      const stopRecording = installCloudRecording(() => { emit(); this.sync().catch(() => {}); });
      const online = () => { this.recordConnection('online'); this.sync().catch(() => {}); emit(); };
      const offline = () => { this.recordConnection('offline'); emit(); };
      globalThis.window?.addEventListener('online', online);
      globalThis.window?.addEventListener('offline', offline);
      const timer = setInterval(() => this.sync().catch(() => {}), 30000);
      const stop = () => { stopRecording(); clearInterval(timer); globalThis.window?.removeEventListener('online', online); globalThis.window?.removeEventListener('offline', offline); };
      try { await this.restoreSession(); if (getCloudState().binding) { if (isOnline()) online(); else offline(); } }
      catch (error) { lastError = error.message; emit(); }
      return stop;
    }
  };
  return client;
}
