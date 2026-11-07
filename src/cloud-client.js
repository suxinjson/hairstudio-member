import { localDb, DEFAULT_SERVICES, DEFAULT_RECHARGE_PLANS } from './storage.js';
import { getCloudState, saveCloudState, installCloudRecording, replayOperation } from './cloud-storage.js';
import { CLOUD_STATE_KEY, canonicalJSON, newId, canWrite, mutationPrecondition, validateOperation, selectSyncBatch } from './sync-protocol.js';
import { DEFAULT_RECHARGE_SETTINGS, normalizeRechargeSettings } from './recharge-settings.js';
import { assertLedgerAccess, ledgerAccessVersion } from './ledger-access.js';

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

  async function raw(path, body, authorization = accessToken, method = body === undefined ? 'GET' : 'POST', { responseType = 'json', timeoutMs = 15000, signal } = {}) {
    const accessVersion = ledgerAccessVersion();
    const state = getCloudState();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (signal?.aborted) throw Object.assign(new Error('播放已停止'), { code: 'VOICE_CANCELLED' });
      const response = await requestFetch(state.serverUrl + '/api/v1' + path, {
        method, headers: { ...(authorization ? { Authorization: 'Bearer ' + authorization } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error'
      });
      const result = responseType === 'blob' && response.ok ? await response.blob() : await response.json();
      assertLedgerAccess(accessVersion);
      networkUnavailable = false;
      if (!response.ok) { const error = new Error(result.error || '云端请求失败'); error.status = response.status; error.code = result.code; throw error; }
      if (responseType === 'blob' && (!/^audio\//i.test(result.type || '') || !result.size || result.size > 8 * 1024 * 1024)) {
        throw Object.assign(new Error('语音服务未返回有效音频'), { status: 502 });
      }
      return result;
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error('播放已停止'), { code: 'VOICE_CANCELLED' });
      if (responseType === 'blob' && controller.signal.aborted) throw Object.assign(new Error('语音合成等待超时，请稍后重试'), { status: 504 });
      if (!error.status) { networkUnavailable = true; const network = new Error('暂时无法连接服务器，仍可离线使用；本机账本和待同步记录已保留'); network.network = true; throw network; }
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }

  async function keepSession(session) {
    const accessVersion = ledgerAccessVersion();
    accessToken = session.accessToken; refreshToken = session.refreshToken;
    const state = getCloudState();
    await vault.save({ refreshToken, serverUrl: state.serverUrl, userId: session.user.id, storeId: session.user.storeId });
    assertLedgerAccess(accessVersion);
    // 原生安全存储是异步的，期间新增的记账操作必须保留。
    const current = getCloudState();
    const forbidden = current.outbox.some(operation => !canWrite(session.user.role, operation.method)) ||
      (current.bootstrap && session.user.role !== 'owner');
    let status = current.status, conflictReason = current.conflictReason;
    if (forbidden) { status = 'conflict'; if (!['recovery', 'integrity'].includes(conflictReason)) conflictReason = 'permissions'; }
    else if (status === 'login-required' || conflictReason === 'permissions') {
      if (conflictReason === 'permissions') conflictReason = null;
      status = current.cloudAdoption || conflictReason ? 'conflict' : current.bootstrap || current.outbox.length ? 'pending' : current.binding ? 'synced' : 'local';
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
  async function request(path, body, method, options) {
    if (offlineEnabled() && !accessToken && !refreshToken) await client.restoreSession();
    if (!accessToken) await refreshSession();
    try { return await raw(path, body, accessToken, method, options); }
    catch (error) { if (error.status !== 401) throw error; await refreshSession(); return raw(path, body, accessToken, method, options); }
  }
  async function verifyAccount(account) {
    if (!account || !Number.isSafeInteger(account.revision) || account.revision < 0 ||
      typeof account.integrity !== 'string' || await sha256(canonicalJSON(account.data)) !== account.integrity) throw integrityError('收到的云端账本校验失败，本机数据未覆盖');
    account.data = localDb.parseAndValidateBackup(JSON.stringify({ data: account.data }), { allowPhoneConflicts: true }).data;
    return account;
  }
  function integrityError(message = '云端账本版本核验失败，请先导出并核对账本') {
    return Object.assign(new Error(message), { code: 'CLOUD_INTEGRITY_CONFLICT' });
  }
  function assertRemoteHead(head, state = getCloudState()) {
    if (!head || !Number.isSafeInteger(head.revision) || head.revision < 0 ||
        !/^[a-f0-9]{64}$/.test(head.integrity || '') || head.revision < state.revision ||
        state.binding && head.revision === state.revision && state.remoteIntegrity && head.integrity !== state.remoteIntegrity) {
      throw integrityError();
    }
  }
  function suspendIntegrity(error) {
    if (!isIntegrityFailure(error)) return;
    const state = getCloudState();
    if (state.binding) {
      setState({ ...state, status: 'conflict', conflictReason: 'integrity',
        syncStatus: 'error', syncError: error.message, remoteConflict: null });
    }
  }
  function isIntegrityFailure(error) {
    return ['CLOUD_INTEGRITY_CONFLICT', 'INTEGRITY_FAILED'].includes(error.code);
  }
  async function accept(account, acknowledged = [], { bind = false } = {}) {
    const accessVersion = ledgerAccessVersion();
    await verifyAccount(account);
    assertLedgerAccess(accessVersion);
    const state = getCloudState();
    assertRemoteHead(account, state);
    const ids = new Set(acknowledged);
    const pending = state.outbox.filter(operation => !ids.has(operation.id));
    let data = account.data;
    try { for (const operation of pending) data = replayOperation(data, operation).data; }
    catch (error) {
      setState({ ...state, revision: account.revision, outbox: pending, remoteConflict: account, status: 'conflict' });
      throw error;
    }
    localDb.applyCloudSnapshot(data, CLOUD_STATE_KEY, { ...state, binding: bind ? { storeId: state.user.storeId } : state.binding,
      revision: account.revision, remoteIntegrity: account.integrity, outbox: pending, bootstrap: null,
      syncStatus: state.syncStatus === 'checking' ? 'checking' : pending.length ? 'pending' : 'confirmed', syncError: '',
      remoteConflict: null, conflictReason: null, status: pending.length ? 'pending' : 'synced', lastSync: clock() }, { allowPhoneConflicts: true });
    onData(); emit();
  }
  async function run(callback) {
    if (busy) return;
    const accessVersion = ledgerAccessVersion();
    busy = true; lastError = ''; emit();
    try { return await callback(); }
    catch (error) {
      let currentPage = true;
      try { assertLedgerAccess(accessVersion); } catch { currentPage = false; }
      if (currentPage) {
        try { suspendIntegrity(error); }
        catch (storageError) {
          lastError = '无法保存账本核对状态：' + storageError.message;
          emit();
          throw new Error(lastError, { cause: error });
        }
      }
      lastError = error.message; emit(); throw error;
    }
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

  async function resolveOriginalWrites() {
    async function resolve(body, ids, progress) {
      const receipt = await verifyAccount(await request('/sync/resolve', body));
      if (!Array.isArray(receipt.resolved) || receipt.resolved.length !== ids.length ||
          receipt.resolved.some((item, i) => item?.id !== ids[i] || !['committed', 'cancelled'].includes(item?.status))) {
        throw new Error('云端核对结果不匹配，本机账本与待同步记录已保留');
      }
      const current = getCloudState(), adoption = current.cloudAdoption;
      assertRemoteHead(receipt, { binding: true, revision: adoption.revision, remoteIntegrity: adoption.integrity });
      setState({ ...current, cloudAdoption: { ...adoption, ...progress, revision: receipt.revision, integrity: receipt.integrity } });
    }
    let state = getCloudState();
    if (!state.cloudAdoption.bootstrapResolved) {
      await resolve({ operations: [], bootstrap: state.bootstrap }, [state.bootstrap.id], { bootstrapResolved: true });
    }
    while (getCloudState().cloudAdoption.cursor < getCloudState().outbox.length) {
      state = getCloudState();
      const operations = selectSyncBatch(state.outbox.slice(state.cloudAdoption.cursor));
      await resolve({ operations }, operations.map(op => op.id), { cursor: state.cloudAdoption.cursor + operations.length });
    }
    const remote = await verifyAccount(await request('/account'));
    state = getCloudState();
    assertRemoteHead(remote, { binding: true, revision: state.cloudAdoption.revision, remoteIntegrity: state.cloudAdoption.integrity });
    return remote;
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
        if ((current.binding && current.binding.storeId !== session.user.storeId) || current.outbox.some(op => op.actorId !== session.user.id) ||
            current.cloudAdoption && current.cloudAdoption.actorId !== session.user.id) {
          await raw('/auth/logout', {}, session.accessToken);
          throw new Error('本机绑定的门店或未同步记录所属账号不同，请使用原账号登录');
        }
        await keepSession(session);
        const remote = await verifyAccount(await request('/account'));
        if (getCloudState().cloudAdoption) return;
        if (old.binding) return;
        const local = localDb.readRecoveryState().data;
        if (!local) { setState({ ...getCloudState(), status: 'needs-choice' }); return; }
        if (autoBootstrap && session.user.role === 'owner' && remote.revision === 0 &&
            !remote.data.members.length && !remote.data.ledgers.length) {
          setState({ ...getCloudState(), status: 'needs-bootstrap' });
          return;
        }
        const hasCustomSettings = canonicalJSON(local.services) !== canonicalJSON(DEFAULT_SERVICES) ||
          canonicalJSON(local.rechargePlans) !== canonicalJSON(DEFAULT_RECHARGE_PLANS) ||
          canonicalJSON(normalizeRechargeSettings(local.rechargeSettings)) !== canonicalJSON(DEFAULT_RECHARGE_SETTINGS);
        if (!local.members.length && !local.ledgers.length && !hasCustomSettings) {
          await accept(remote, [], { bind: true });
        } else {
          setState({ ...getCloudState(), status: remote.revision === 0 && !remote.data.members.length && session.user.role === 'owner' ? 'needs-bootstrap' : 'needs-choice' });
        }
      });
    },
    async restoreSession() {
      if (restorePromise) return restorePromise;
      restorePromise = (async () => {
        const accessVersion = ledgerAccessVersion();
        const state = getCloudState();
        if (!state.serverUrl || !state.user) return;
        let saved;
        try { saved = await vault.load(); }
        catch (error) { if (!offlineEnabled()) throw error; }
        assertLedgerAccess(accessVersion);
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
        if (state.cloudAdoption) throw new Error('请先完成采用云端账本的核对');
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
      if (!state.binding || !state.user || !state.serverUrl || !isOnline() || state.cloudAdoption || state.status === 'conflict' || state.conflictReason === 'integrity' || busy) return;
      const syncAccessVersion = ledgerAccessVersion();
      return run(async () => {
        setState({ ...getCloudState(), syncStatus: 'checking', syncError: '' });
        try {
          // Check before uploading: a pending write must not advance a rolled-back
          // server to the previously observed revision and hide the rollback.
          let checkedHead = null;
          if (!getCloudState().bootstrap) {
            checkedHead = await request('/account/head');
            assertRemoteHead(checkedHead);
          }
          if (getCloudState().bootstrap) await accept(await sendOperations('/account/bootstrap', getCloudState().bootstrap));
          for (let count = 0; count < 10; count++) {
            const operations = selectSyncBatch(getCloudState().outbox);
            if (!operations.length) break;
            const response = await sendOperations('/sync', { operations, ...(checkedHead ? { observedHead: checkedHead } : {}) });
            if (canonicalJSON(response.acknowledged) !== canonicalJSON(operations.map(operation => operation.id))) throw new Error('云端确认单号不匹配，待同步记录已保留');
            await accept(response, response.acknowledged);
            checkedHead = { revision: getCloudState().revision, integrity: getCloudState().remoteIntegrity };
          }
          const head = await request('/account/head'), observed = getCloudState();
          assertRemoteHead(head, observed);
          if (head.revision > observed.revision || !observed.remoteIntegrity) await accept(await request('/account'));
          await flushActivity();
          const current = getCloudState();
          setState({ ...current, syncStatus: current.outbox.length ? 'pending' : 'confirmed', syncError: '', lastSync: clock() });
        } catch (error) {
          // An older page may finish after another page has acquired the ledger.
          try { assertLedgerAccess(syncAccessVersion); } catch { throw error; }
          if (!isIntegrityFailure(error)) setState({ ...getCloudState(), syncStatus: 'error', syncError: error.message });
          throw error;
        }
      });
    },
    async useCloudLedger() {
      return run(async () => {
        if (!getCloudState().user) throw new Error('请先登录');
        let state = getCloudState();
        if (state.cloudAdoption?.mode === 'upload') throw new Error('请继续核对并上传恢复账本');
        if (!state.cloudAdoption) {
          const head = await verifyAccount(await request('/account'));
          state = getCloudState();
          if (head.revision < state.revision) throw integrityError('云端版本发生回退，不能替换本机账本；请由店主核对恢复');
          // Persist the original ledger and the write fence before cancelling anything remotely.
          preserveLocal(state);
          setState({ ...state, status: 'conflict', conflictReason: state.conflictReason || 'adoption',
            cloudAdoption: { cursor: 0, bootstrapResolved: !state.bootstrap, actorId: state.user.id,
              revision: head.revision, integrity: head.integrity } });
        }
        const remote = await resolveOriginalWrites();
        state = getCloudState();
        localDb.applyCloudSnapshot(remote.data, CLOUD_STATE_KEY, { ...state, binding: { storeId: state.user.storeId },
          outbox: [], bootstrap: null, cloudAdoption: null, status: 'synced', revision: remote.revision, remoteIntegrity: remote.integrity,
          syncStatus: 'confirmed', syncError: '', lastSync: clock(), remoteConflict: null, conflictReason: null }, { allowRecovery: true, allowPhoneConflicts: true });
        onData(); emit();
        this.recordConnection('sync_conflict_resolved');
      });
    },
    async uploadRecoveredLedger() {
      return run(async () => {
        const initial = getCloudState();
        if (initial.cloudAdoption && initial.cloudAdoption.mode !== 'upload') throw new Error('请先完成采用云端账本的核对');
        if (initial.user?.role !== 'owner' || initial.status !== 'conflict' || !['recovery', 'integrity'].includes(initial.conflictReason)) throw new Error('仅店主可以确认上传需核对的本机完整账本；已上传的恢复操作请通过同步重试');
        if (!isOnline()) throw new Error('请联网后上传恢复账本');
        // Keep the restored ledger and original IDs until every original request is fenced.
        // The durable mode lets a restart resume this action without adopting the remote data.
        if (!initial.cloudAdoption) {
          localDb.readBackupState();
          const head = await verifyAccount(await request('/account'));
          const current = getCloudState();
          if (current.user?.role !== 'owner' || current.conflictReason !== initial.conflictReason) throw new Error('账号权限已变化，恢复账本尚未上传');
          if (head.revision < current.revision && current.conflictReason !== 'integrity') throw integrityError('云端版本发生回退，不能上传恢复账本');
          preserveLocal(current);
          setState({ ...current, cloudAdoption: { mode: 'upload', cursor: 0, bootstrapResolved: !current.bootstrap,
            actorId: current.user.id, revision: head.revision, integrity: head.integrity } });
        }
        const remote = await resolveOriginalWrites();
        const state = getCloudState();
        if (state.user?.role !== 'owner' || state.conflictReason !== initial.conflictReason) throw new Error('账号权限已变化，恢复账本尚未上传');
        if (remote.revision < state.revision && state.conflictReason !== 'integrity') throw integrityError('云端版本发生回退，不能上传恢复账本');
        const data = localDb.readBackupState();
        const args = [JSON.stringify({ data }), { mode: 'replace' }];
        const operation = { id: newId(), method: 'importBackupData', args,
          actorId: state.user.id, deviceId: state.deviceId, generated: { ids: [], times: [clock()] },
          precondition: mutationPrecondition(remote.data, 'importBackupData', args) };
        validateOperation(operation);
        // Only replace the original queue after all cancellation receipts are durable.
        localDb.applyCloudSnapshot(data, CLOUD_STATE_KEY, { ...state, outbox: [operation], bootstrap: null,
          cloudAdoption: null,
          remoteConflict: null, revision: remote.revision, remoteIntegrity: remote.integrity,
          conflictReason: state.conflictReason === 'integrity' ? null : state.conflictReason,
          syncStatus: 'pending', syncError: '', status: 'pending' });
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
      if (busy || getCloudState().cloudAdoption || getCloudState().outbox.length || getCloudState().bootstrap) throw new Error('请先同步待办记录，才能解除绑定');
      await this.logout();
      setState({ ...getCloudState(), binding: null, serverUrl: '', user: null, revision: 0, status: 'local', conflictReason: null, remoteConflict: null });
    },
    recordConnection(type) {
      const state = getCloudState();
      if (!state.binding || !state.user) return;
      setState({ ...state, activity: [...state.activity, { id: newId(), type, at: clock(), actorId: state.user.id, deviceId: state.deviceId }] });
    },
    request,
    getVoiceConfig() { return request('/voice/config'); },
    getAliGenieDevices() { return request('/voice/aligenie/devices'); },
    getUsers() { return request('/users'); },
    saveVoiceConfig(config) { return request('/voice/config', config, 'POST'); },
    previewVoice(options, { signal } = {}) {
      const { text, provider, apiUrl, apiKey, appId, model, voiceId } = options;
      return request('/voice/synthesize', { text, test: true, provider, apiUrl, apiKey, appId, model, voiceId }, 'POST', { responseType: 'blob', timeoutMs: 130000, signal });
    },
    synthesizeVoice({ text }, { signal } = {}) {
      return request('/voice/synthesize', { text }, 'POST', { responseType: 'blob', timeoutMs: 130000, signal });
    },
    async downloadAuthorization() { await refreshSession(); return accessToken; },
    async start() {
      const stopRecording = installCloudRecording(() => { emit(); this.sync().catch(() => {}); }, { allowLocal: offlineEnabled });
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
