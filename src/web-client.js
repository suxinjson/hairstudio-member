import { watch } from 'vue';
import { ADMIN_SESSION_KEY, AdminApiClient, buildAdminOperation } from '../admin/src/api/client.js';
import { createLocalDb, STORAGE_KEYS, DEFAULT_SERVICES, DEFAULT_RECHARGE_PLANS } from './storage.js';
import { replayOperation } from './cloud-storage.js';
import { canWrite } from './sync-protocol.js';

// Browser account data is a projection of a verified server response. No local
// ledger, migration state or offline journal participates in this client.
export function createWebClient({ api = new AdminApiClient(), onData = () => {}, eventTarget = globalThis.window } = {}) {
  const listeners = new Set();
  let busy = false, running = null;
  const empty = { members: [], ledgers: [], services: DEFAULT_SERVICES, rechargePlans: DEFAULT_RECHARGE_PLANS };
  let projectedData, projection;
  function readDb() {
    const data = api.accountData.value || empty;
    if (data !== projectedData) {
      projectedData = data;
      const values = new Map(Object.entries({
        [STORAGE_KEYS.MEMBERS]: data.members, [STORAGE_KEYS.LEDGERS]: data.ledgers,
        [STORAGE_KEYS.SERVICES]: data.services, [STORAGE_KEYS.RECHARGE_PLANS]: data.rechargePlans,
        ...(data.rechargeSettings === undefined ? {} : { [STORAGE_KEYS.RECHARGE_SETTINGS]: data.rechargeSettings })
      }).map(([key, value]) => [key, JSON.stringify(value)]));
      projection = createLocalDb({ getItem: key => values.get(key) ?? null,
        setItem: () => { throw new Error('网页账本只能由服务器更新'); }, removeItem: () => { throw new Error('网页账本只能由服务器更新'); } });
    }
    return projection;
  }
  const db = { webOnly: true, init() {}, getLocalSnapshots: () => [] };
  for (const method of ['getMembers', 'getMemberById', 'getLedgers', 'getDashboard', 'getServices',
    'getRechargePlans', 'getRechargeSettings', 'readBackupState', 'parseAndValidateBackup', 'exportBackupData', 'exportCSV']) {
    db[method] = (...args) => {
      if (['exportBackupData', 'exportCSV', 'readBackupState'].includes(method) && !api.accountData.value) throw new Error('请先从服务器加载账本');
      if (method === 'exportBackupData') return readDb()[method]({ archiveSnapshot: false });
      return readDb()[method](...args);
    };
  }
  for (const method of ['createMember', 'updateMember', 'deleteMember', 'consume', 'recharge', 'refundLedger', 'saveService', 'deleteService', 'saveRechargeSettings']) {
    db[method] = async (...args) => {
      api.restoreSession();
      if (busy || api.hasPending.value) throw new Error('请先确认上一笔操作的服务器结果');
      if (!client.canWrite(method)) throw new Error('请登录并重新加载服务器账本后操作');
      // Capture the form and its precondition before an asynchronous request.
      const operation = buildAdminOperation(method, JSON.parse(JSON.stringify(args)), api.accountData.value, api.identity());
      const { result } = replayOperation(api.accountData.value, operation);
      await run(() => api.sync([operation]));
      return result;
    };
  }
  function emit() { for (const listener of listeners) listener(client.snapshot()); }
  async function run(action) {
    if (busy) throw new Error('服务器请求正在处理，请稍候');
    busy = true; emit();
    try { return await action(); }
    catch (error) { api.accountStatus.value = 'error'; api.accountError.value = error.message; throw error; }
    finally { busy = false; emit(); }
  }
  const client = {
    getDb: () => db,
    canWrite: method => Boolean(api.user.value && !api.isLocked.value && api.accountData.value &&
      api.accountStatus.value === 'synced' && !api.headConflict.value && !api.hasPending.value && !busy && canWrite(api.user.value.role, method)),
    snapshot() {
      const locked = api.isLocked.value;
      return { webOnly: true, serverUrl: api.serverOrigin, user: locked ? null : api.user.value,
        storeProfile: api.storeProfile.value,
        binding: api.user.value ? { storeId: api.user.value.storeId } : null,
        deviceId: api.deviceId, revision: api.accountRevision.value, outbox: [], activity: [], busy,
        online: api.accountStatus.value === 'synced' || api.accountStatus.value === 'pending',
        status: api.headConflict.value ? 'conflict' : api.accountStatus.value, pending: api.hasPending.value, locked,
        error: api.accountError.value || (api.headConflict.value ? '服务器账本版本需要核对，请在管理后台处理' : ''),
        syncStatus: api.accountStatus.value === 'synced' ? 'confirmed' : api.accountStatus.value === 'error' ? 'error' : 'checking' };
    },
    subscribe(listener) { listeners.add(listener); listener(client.snapshot()); return () => listeners.delete(listener); },
    async login(_serverUrl, username, password) { return run(async () => { await api.login(username, password); await api.getAccount(); }); },
    logout() { return run(() => api.logout()); },
    restoreSession() { api.restoreSession(); return Promise.resolve(); },
    recordConnection() {},
    sync() {
      api.restoreSession();
      if (!api.user.value || api.isLocked.value || busy) return Promise.resolve();
      return run(() => api.getAccount());
    },
    retryPending() { return run(() => api.retryPending()); },
    resolvePending() { return run(() => api.resolvePending()); },
    request(path, body, method = body === undefined ? 'GET' : 'POST') {
      return api.request('/api/v1' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
    getVoiceConfig: () => api.getVoiceConfig(), getUsers: () => api.getUsers(),
    getStoreProfile: () => api.storeProfile.value,
    loadStoreProfile: () => run(() => api.loadStoreProfile()),
    saveStoreProfile: (profile, expectedVersion) => run(() => api.saveStoreProfile(profile, expectedVersion)),
    getAliGenieDevices: () => api.request('/api/v1/voice/aligenie/devices'),
    saveVoiceConfig: config => api.saveVoiceConfig(config),
    previewVoice: (options, control) => api.synthesizeVoice({ ...options, test: true }, control),
    synthesizeVoice: (options, control) => api.synthesizeVoice(options, control),
    async start() {
      if (running) return running;
      const refresh = () => client.sync().catch(() => {});
      const activity = () => api.recordActivity();
      const storageChanged = event => {
        api.restoreSession();
        if (!api.user.value || api.isLocked.value) return;
        if (event.key === null || event.key === api.headKey()) return refresh();
        if (event.key !== ADMIN_SESSION_KEY) return;
        let previous;
        try { previous = JSON.parse(event.oldValue || 'null'); } catch {}
        // Activity deadlines and token refreshes share this storage key. They
        // must not each download the full ledger in every open cashier tab.
        if (!api.accountData.value || previous?.isLocked || previous?.user?.role !== api.user.value.role) refresh();
      };
      const timer = setInterval(refresh, 30000);
      eventTarget?.addEventListener('online', refresh);
      eventTarget?.addEventListener('storage', storageChanged);
      eventTarget?.addEventListener('pointerdown', activity);
      eventTarget?.addEventListener('keydown', activity);
      running = () => {
        clearInterval(timer);
        eventTarget?.removeEventListener('online', refresh);
        eventTarget?.removeEventListener('storage', storageChanged);
        eventTarget?.removeEventListener('pointerdown', activity);
        eventTarget?.removeEventListener('keydown', activity);
        running = null;
      };
      await client.sync().catch(() => {});
      return running;
    },
    dispose() { running?.(); stopWatch(); api.dispose(); listeners.clear(); }
  };
  const stopWatch = watch(() => [api.user.value, api.isLocked.value, api.accountData.value, api.accountStatus.value,
    api.accountError.value, api.hasPending.value, api.headConflict.value, api.storeProfile.value], (next, previous) => {
    emit(); if (next[2] !== previous[2]) onData();
  }, { flush: 'sync' });
  return client;
}
