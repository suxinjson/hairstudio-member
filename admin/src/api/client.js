import { ref, customRef } from 'vue';
import { newId, mutationPrecondition, validateOperation, canonicalJSON, selectSyncBatch } from '../../../src/sync-protocol.js';
import { DEFAULT_SERVICES, DEFAULT_RECHARGE_PLANS, localDb } from '../../../src/storage.js';
import { sha256 } from '../../../src/cloud-client.js';
import { withBrowserLock } from '../utils/browser-lock.js';

const STORAGE_KEY = 'hairstudio_admin_auth';
const emptyData = () => ({ members: [], ledgers: [], services: DEFAULT_SERVICES, rechargePlans: DEFAULT_RECHARGE_PLANS });
const identityKey = user => user ? user.storeId + ':' + user.id : '';
const sessionError = () => Object.assign(new Error('登录账号已变化，请重新加载账本'), { status: 401, code: 'SESSION_CHANGED' });
const centToAmount = cents => (BigInt(cents) / 100n).toString() + '.' + (BigInt(cents) % 100n).toString().padStart(2, '0');

export class AdminApiClient {
  constructor({ storage = globalThis.localStorage, fetch: requestFetch = (...args) => fetch(...args),
    locks, indexedDB, eventTarget = globalThis.window } = {}) {
    this.storage = storage; this.requestFetch = requestFetch; this.lockOptions = { locks, indexedDB };
    this.accessToken = ref(''); this.refreshToken = ref(''); this.user = ref(null);
    this.accountData = ref(null); this.accountRevision = ref(0);
    this.accountStatus = ref('idle'); this.accountError = ref('');
    this.hasPending = ref(false); this.pendingImport = ref(null); this.importing = ref(false);
    this.generation = 0; this.loadSequence = 0; this.applyingSession = false; this.refreshPromise = null;
    this.lockSignals = new Set();
    this.deviceId = this.getOrCreateDeviceId(); this.isLocked = this.createLockedRef(); this.restoreSession();
    const storageChanged = event => {
      if (event.key === STORAGE_KEY || event.key === null) this.restoreSession();
      this.readPending();
    };
    const offline = () => { this.accountStatus.value = 'error'; this.accountError.value = '当前离线，请联网后重新确认账本'; };
    eventTarget?.addEventListener('storage', storageChanged); eventTarget?.addEventListener('offline', offline);
    this.dispose = () => { eventTarget?.removeEventListener('storage', storageChanged); eventTarget?.removeEventListener('offline', offline); };
  }

  lock(name, callback) {
    return withBrowserLock('hairstudio-admin-' + name, async signal => {
      if (signal) this.lockSignals.add(signal);
      try { return await callback(); } finally { if (signal) this.lockSignals.delete(signal); }
    }, this.lockOptions);
  }
  scopedKey(kind) { return 'hairstudio_admin_' + kind + ':' + identityKey(this.user.value); }
  readSavedSession() { const raw = this.storage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : null; }

  createLockedRef() {
    return customRef((track, trigger) => {
      let value = false;
      return {
        get() { track(); return value; },
        set: newValue => {
          value = Boolean(newValue); trigger();
          if (this.applyingSession || !this.user.value) return;
          const saved = this.readSavedSession();
          if (identityKey(saved?.user) === identityKey(this.user.value)) this.storage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, isLocked: value }));
        }
      };
    });
  }

  getOrCreateDeviceId() {
    let id = this.storage.getItem('hairstudio_device_id');
    if (!id) { id = 'pc-admin-' + newId(); this.storage.setItem('hairstudio_device_id', id); }
    return id;
  }

  applySession(data) {
    if (identityKey(data?.user) !== identityKey(this.user.value)) {
      this.generation++; this.loadSequence++;
      this.accountData.value = null; this.accountRevision.value = 0;
      this.accountStatus.value = 'idle'; this.accountError.value = '';
    }
    this.accessToken.value = data?.accessToken || ''; this.refreshToken.value = data?.refreshToken || '';
    this.user.value = data?.user || null;
    this.applyingSession = true;
    try { this.isLocked.value = Boolean(data?.isLocked); } finally { this.applyingSession = false; }
    this.readPending();
  }

  restoreSession() {
    try { this.applySession(this.readSavedSession()); } catch { this.applySession(null); }
  }

  saveSession(data, isLocked = this.isLocked.value) {
    this.storage.setItem(STORAGE_KEY, JSON.stringify({ ...data, isLocked }));
    this.applySession({ ...data, isLocked });
  }

  clearSession() { this.applySession(null); this.storage.removeItem(STORAGE_KEY); }

  assertSession(generation) {
    if ([...this.lockSignals].some(signal => signal.aborted)) throw new Error('安全同步锁失效，请重试原操作');
    this.restoreSession();
    if (generation !== this.generation || !this.user.value) throw sessionError();
  }

  readPending() {
    if (!this.user.value) { this.hasPending.value = false; this.pendingImport.value = null; return; }
    try {
      const job = JSON.parse(this.storage.getItem(this.scopedKey('import')) || 'null');
      this.pendingImport.value = job?.status === 'pending' ? { count: job.count, total: job.total, canCancel: Boolean(job.canCancel) } : null;
      this.hasPending.value = Boolean(this.storage.getItem(this.scopedKey('pending')) || this.pendingImport.value);
    } catch {
      this.hasPending.value = true; this.accountStatus.value = 'error'; this.accountError.value = '待确认记录损坏，请保留浏览器数据并联系管理员';
    }
  }

  async fetchJSON(path, options = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    const signals = [...this.lockSignals], abort = () => controller.abort();
    for (const signal of signals) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }
    try {
      const response = await this.requestFetch(path, { ...options, signal: controller.signal, cache: 'no-store', redirect: 'error' });
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(data.error || '请求失败 (' + response.status + ')'), {
        status: response.status, code: data.code,
        ...(response.status === 429 ? { retryAfter: Math.min(60, Math.max(1, Number(response.headers.get('Retry-After')) || 60)) } : {})
      });
      return data;
    } finally { clearTimeout(timer); for (const signal of signals) signal.removeEventListener('abort', abort); }
  }

  async request(path, options = {}) {
    this.restoreSession();
    const generation = this.generation, previousAccess = this.accessToken.value;
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}), ...(previousAccess ? { Authorization: 'Bearer ' + previousAccess } : {}) };
    try {
      let data;
      try { data = await this.fetchJSON(path, { ...options, headers }); }
      catch (error) {
        if (error.status !== 401 || path.startsWith('/api/v1/auth/')) throw error;
        this.assertSession(generation);
        if (!await this.refresh(previousAccess)) throw Object.assign(new Error('登录会话已过期，请重新登录'), { status: 401 });
        this.assertSession(generation);
        data = await this.fetchJSON(path, { ...options, headers: { ...headers, Authorization: 'Bearer ' + this.accessToken.value } });
      }
      this.assertSession(generation);
      return data;
    } catch (error) {
      if (error.status === 401 && this.generation === generation) this.clearSession();
      throw error;
    }
  }

  async login(username, password) {
    return this.lock('auth', async () => {
      const data = await this.fetchJSON('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, deviceId: this.deviceId }) });
      this.saveSession(data, false);
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

  async acceptAccount(response, generation) {
    if (!response || !Number.isSafeInteger(response.revision) || response.revision < 0 ||
        await sha256(canonicalJSON(response.data)) !== response.integrity) throw new Error('云端账本校验失败，待确认操作已保留');
    const data = localDb.parseAndValidateBackup(JSON.stringify({ data: response.data })).data;
    this.assertSession(generation);
    if (response.revision < this.accountRevision.value) throw new Error('云端账本版本回退，请联系管理员');
    this.accountData.value = data; this.accountRevision.value = response.revision;
  }

  async getAccount() {
    this.restoreSession();
    const generation = this.generation, sequence = ++this.loadSequence;
    this.accountStatus.value = 'loading'; this.accountError.value = '';
    try {
      const response = await this.request('/api/v1/account');
      if (sequence !== this.loadSequence) throw sessionError();
      await this.acceptAccount(response, generation);
      this.readPending(); this.accountStatus.value = this.hasPending.value ? 'pending' : 'synced';
      return response;
    } catch (error) {
      if (generation === this.generation && sequence === this.loadSequence) {
        this.accountStatus.value = 'error'; this.accountError.value = error.message;
      }
      throw error;
    }
  }

  async sync(operations, importId = null) {
    this.restoreSession();
    const generation = this.generation, key = this.scopedKey('pending');
    return this.lock('writes', async () => {
      this.assertSession(generation);
      if (this.isLocked.value) throw new Error('请先解锁工作台');
      const job = JSON.parse(this.storage.getItem(this.scopedKey('import')) || 'null');
      if (job?.status === 'pending' && job.id !== importId) throw new Error('请先继续未完成的导入任务');
      operations.forEach(validateOperation);
      if (operations.some(operation => operation.actorId !== this.user.value.id || operation.deviceId !== this.deviceId)) throw new Error('操作账号或设备已变化，请重新核对');
      if (!operations.length || selectSyncBatch(operations).length !== operations.length) throw new Error('操作批次超过单次同步容量');
      let pending = JSON.parse(this.storage.getItem(key) || 'null');
      if (pending && canonicalJSON(pending.operations) !== canonicalJSON(operations)) throw new Error('存在待确认操作，请先重试原操作');
      if (!pending) {
        pending = { operations, uncertain: false };
        // Persist stable IDs before sending any financial write.
        this.storage.setItem(key, JSON.stringify(pending));
      }
      this.readPending(); this.loadSequence++;
      this.accountStatus.value = 'saving'; this.accountError.value = '';
      try {
        const response = await this.request('/api/v1/sync', { method: 'POST', body: JSON.stringify({ operations: pending.operations }) });
        if (canonicalJSON(response.acknowledged) !== canonicalJSON(pending.operations.map(operation => operation.id))) throw new Error('云端确认单号不匹配，请重试原操作');
        await this.acceptAccount(response, generation);
        this.storage.removeItem(key); this.readPending();
        this.accountStatus.value = this.hasPending.value ? 'pending' : 'synced';
        return response;
      } catch (error) {
        // A definitive first-attempt rejection committed nothing. Uncertain retries retain their IDs.
        if (!pending.uncertain && [400, 403, 409, 413, 415, 429].includes(error.status)) this.storage.removeItem(key);
        else this.storage.setItem(key, JSON.stringify({ ...pending, uncertain: true }));
        if (generation === this.generation) {
          this.readPending(); this.accountStatus.value = 'error'; this.accountError.value = error.message;
        }
        throw error;
      }
    });
  }

  async retryPending(onProgress) {
    this.restoreSession();
    if (this.pendingImport.value) return this.resumeBatchImport(onProgress);
    const pending = JSON.parse(this.storage.getItem(this.scopedKey('pending')) || 'null');
    if (pending) return this.sync(pending.operations);
  }

  getUsers() { return this.request('/api/v1/users'); }
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

  planImport(items, strategy, allowDebt) {
    if (!['skip', 'merge_balance', 'overwrite_profile'].includes(strategy) || !this.accountData.value) throw new Error('请先加载账本并选择有效的导入策略');
    const data = this.accountData.value, batches = []; let batch = { operations: [], count: 0 };
    for (const item of items) {
      if (!['valid_new', 'conflict'].includes(item.status)) throw new Error('导入中包含未通过预检的记录');
      const { balanceCents, giftCents = 0 } = item.data, credit = balanceCents + giftCents;
      if (![balanceCents, giftCents, credit].every(Number.isSafeInteger) || giftCents < 0) throw new Error('导入金额格式无效');
      if (credit < 0 && !allowDebt && (item.status === 'valid_new' || strategy === 'merge_balance')) throw new Error('请先确认期初欠款导入');
      const notes = [item.data.tag ? '[' + item.data.tag + ']' : '', item.data.remark || ''].filter(Boolean).join(' ');
      const operations = [];
      if (item.status === 'valid_new') {
        const create = buildAdminOperation('createMember', [{ name: item.data.name, phone: item.data.phone, initialBalance: centToAmount(Math.max(0, credit)), notes }], data, this.identity());
        operations.push(create);
        if (credit < 0) {
          const member = { id: create.generated.ids[0], name: item.data.name.trim(), phone: item.data.phone.trim(), balance: 0,
            total_recharge: 0, total_consume: 0, notes: notes.trim(), created_at: create.generated.times[0], updated_at: create.generated.times[0] };
          operations.push(buildAdminOperation('consume', [{ memberId: member.id, amount: centToAmount(-credit), itemsSummary: '期初导入欠款', allowDebt: true }], { ...data, members: [member] }, this.identity()));
        }
      } else if (strategy === 'overwrite_profile') {
        operations.push(buildAdminOperation('updateMember', [item.existingMember.id, { name: item.data.name, phone: item.data.phone, notes: notes || item.existingMember.notes || '' }], data, this.identity()));
      } else if (strategy === 'merge_balance' && credit !== 0) {
        if (credit < 0) operations.push(buildAdminOperation('consume', [{ memberId: item.existingMember.id, amount: centToAmount(-credit), itemsSummary: '期初导入欠款', remark: notes, allowDebt: true }], data, this.identity()));
        else {
          if (balanceCents >= 0 && giftCents > 0 && data.rechargeSettings?.giftEnabled === false) throw new Error('当前充值赠送已关闭，请先核对赠送规则');
          operations.push(buildAdminOperation('recharge', [{ memberId: item.existingMember.id, actualPay: centToAmount(balanceCents < 0 ? credit : balanceCents),
            giftAmount: centToAmount(balanceCents < 0 ? 0 : giftCents), payMethod: '期初导入', remark: notes }], data, this.identity()));
        }
      }
      if (!operations.length) continue;
      const candidate = [...batch.operations, ...operations];
      if (candidate.length > 100 || selectSyncBatch(candidate).length !== candidate.length || batch.count >= 50) {
        if (batch.count) batches.push(batch);
        batch = { operations: [], count: 0 };
      }
      batch.operations.push(...operations); batch.count++;
    }
    if (batch.count) batches.push(batch);
    return { batches, total: batches.reduce((sum, row) => sum + row.count, 0) };
  }

  async executeBatchImport(items, strategy, onProgress = () => {}, { allowDebt = false } = {}) {
    this.restoreSession();
    const generation = this.generation, signature = await sha256(canonicalJSON({ strategy, rows: items.map(item => item.data) }));
    return this.lock('import', async () => {
      this.assertSession(generation);
      const key = this.scopedKey('import'); let job = JSON.parse(this.storage.getItem(key) || 'null');
      if (job?.signature === signature && job.status === 'complete') return { success: true, count: job.count, resumed: true };
      if (job?.status === 'pending' && job.signature !== signature) throw new Error('存在未完成的导入任务，请先继续原任务');
      if (!job || job.signature !== signature || job.status === 'cancelled') {
        if (this.storage.getItem(this.scopedKey('pending'))) throw new Error('请先确认之前的财务操作');
        job = { id: newId(), signature, status: 'pending', cursor: 0, count: 0, ...this.planImport(items, strategy, allowDebt) };
        this.storage.setItem(key, JSON.stringify(job));
      }
      return this.runImport(job, key, generation, onProgress);
    });
  }

  async resumeBatchImport(onProgress = () => {}) {
    this.restoreSession(); const generation = this.generation;
    return this.lock('import', async () => {
      this.assertSession(generation);
      const key = this.scopedKey('import'), job = JSON.parse(this.storage.getItem(key) || 'null');
      if (!job || job.status !== 'pending') throw new Error('没有待继续的导入任务');
      return this.runImport(job, key, generation, onProgress);
    });
  }

  async cancelRemainingImport() {
    return this.lock('import', async () => {
      this.restoreSession();
      const key = this.scopedKey('import'), job = JSON.parse(this.storage.getItem(key) || 'null');
      if (!job?.canCancel || this.storage.getItem(this.scopedKey('pending'))) throw new Error('操作结果尚未确认，不能取消');
      this.storage.setItem(key, JSON.stringify({ ...job, status: 'cancelled', batches: [] }));
      this.readPending();
    });
  }

  async runImport(job, key, generation, onProgress) {
    this.importing.value = true; this.readPending();
    try {
      while (job.cursor < job.batches.length) {
        this.assertSession(generation);
        const batch = job.batches[job.cursor];
        await this.sync(batch.operations, job.id);
        this.assertSession(generation);
        job = { ...job, cursor: job.cursor + 1, count: job.count + batch.count, canCancel: false };
        this.storage.setItem(key, JSON.stringify(job));
        this.readPending(); onProgress(Math.round(job.count * 100 / job.total));
      }
      this.storage.setItem(key, JSON.stringify({ id: job.id, signature: job.signature, status: 'complete', count: job.count, total: job.total }));
      this.readPending(); this.accountStatus.value = 'synced'; onProgress(100);
      return { success: true, count: job.count };
    } catch (error) {
      if ([400, 403, 409, 413, 415].includes(error.status) && !this.storage.getItem(this.scopedKey('pending'))) {
        this.storage.setItem(key, JSON.stringify({ ...job, canCancel: true })); this.readPending();
      }
      throw error;
    } finally { this.importing.value = false; }
  }
}

export function buildAdminOperation(method, args, accountData = null, identity = null) {
  const user = identity || adminApi.identity();
  if (!user.id || !user.deviceId) throw new Error('请先登录');
  const now = new Date().toISOString(); let ids = [], times = [now];
  if (method === 'createMember') {
    ids = Number(args[0]?.initialBalance || 0) > 0 ? [newId(), newId()] : [newId()];
    if (ids.length === 2) times = [now, now];
  } else if (['recharge', 'consume', 'refundLedger'].includes(method)) ids = [newId()];
  else if (method === 'saveService' && !args[0]?.id) ids = [newId()];
  const operation = { id: newId(), method, args, actorId: user.id, deviceId: user.deviceId,
    generated: { ids, times }, precondition: mutationPrecondition(accountData || adminApi.accountData.value || emptyData(), method, args) };
  validateOperation(operation); return operation;
}

export const adminApi = new AdminApiClient();
