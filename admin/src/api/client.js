import { ref, customRef } from 'vue';
import { newId, mutationPrecondition, validateOperation, canonicalJSON, selectSyncBatch } from '../../../src/sync-protocol.js';
import { DEFAULT_SERVICES, DEFAULT_RECHARGE_PLANS, localDb } from '../../../src/storage.js';
import { sha256 } from '../../../src/cloud-client.js';
import { withBrowserLock } from '../utils/browser-lock.js';
import { normalizeMemberPhone, validateActiveMemberPhones } from '../../../src/accounting.js';

const STORAGE_KEY = 'hairstudio_admin_auth';
export const ADMIN_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const emptyData = () => ({ members: [], ledgers: [], services: DEFAULT_SERVICES, rechargePlans: DEFAULT_RECHARGE_PLANS });
const identityKey = user => user ? user.storeId + ':' + user.id : '';
const sessionError = () => Object.assign(new Error('登录账号已变化，请重新加载账本'), { status: 401, code: 'SESSION_CHANGED' });
const centToAmount = cents => (BigInt(cents) / 100n).toString() + '.' + (BigInt(cents) % 100n).toString().padStart(2, '0');

const memoryStorage = () => {
  const map = new Map();
  return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
};

export class AdminApiClient {
  constructor({ storage = globalThis.localStorage || memoryStorage(), fetch: requestFetch = (...args) => fetch(...args),
    locks, indexedDB, eventTarget = globalThis.window } = {}) {
    this.storage = storage; this.requestFetch = requestFetch; this.lockOptions = { locks, indexedDB };
    this.accessToken = ref(''); this.refreshToken = ref(''); this.user = ref(null);
    this.idleExpiresAt = ref(null);
    this.accountData = ref(null); this.accountRevision = ref(0);
    this.accountStatus = ref('idle'); this.accountError = ref('');
    this.hasPending = ref(false); this.pendingOperation = ref(false); this.pendingImport = ref(null); this.importing = ref(false);
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
    this.idleExpiresAt.value = data?.idleExpiresAt ?? null;
    this.applyingSession = true;
    try { this.isLocked.value = Boolean(data?.isLocked); } finally { this.applyingSession = false; }
    this.readPending();
  }

  restoreSession() {
    try {
      let saved = this.readSavedSession();
      // Legacy sessions have no trusted activity deadline and must be unlocked once.
      if (saved?.user && !saved.isLocked && (!Number.isSafeInteger(saved.idleExpiresAt) || saved.idleExpiresAt <= Date.now())) {
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
    this.storage.setItem(STORAGE_KEY, JSON.stringify({ ...data, isLocked, idleExpiresAt }));
    this.restoreSession();
  }

  recordActivity() {
    // Check expiry before recording input so resuming an idle tab cannot unlock it.
    this.restoreSession();
    if (!this.user.value || this.isLocked.value) return;
    const saved = this.readSavedSession();
    const next = { ...saved, idleExpiresAt: Date.now() + ADMIN_IDLE_TIMEOUT_MS };
    this.storage.setItem(STORAGE_KEY, JSON.stringify(next));
    this.applySession(next);
  }

  clearSession() { this.applySession(null); this.storage.removeItem(STORAGE_KEY); }

  assertSession(generation) {
    if ([...this.lockSignals].some(signal => signal.aborted)) throw new Error('安全同步锁失效，请重试原操作');
    this.restoreSession();
    if (generation !== this.generation || !this.user.value) throw sessionError();
  }

  readPending() {
    if (!this.user.value) { this.hasPending.value = false; this.pendingOperation.value = false; this.pendingImport.value = null; return; }
    try {
      const job = JSON.parse(this.storage.getItem(this.scopedKey('import')) || 'null');
      this.pendingImport.value = job?.status === 'pending' ? { count: job.count, total: job.total, canCancel: Boolean(job.canCancel) } : null;
      this.pendingOperation.value = Boolean(this.storage.getItem(this.scopedKey('pending')));
      this.hasPending.value = Boolean(this.pendingOperation.value || this.pendingImport.value);
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

  async acceptAccount(response, generation) {
    if (!response || !Number.isSafeInteger(response.revision) || response.revision < 0 ||
        await sha256(canonicalJSON(response.data)) !== response.integrity) throw new Error('云端账本校验失败，待确认操作已保留');
    const data = localDb.parseAndValidateBackup(JSON.stringify({ data: response.data }), { allowPhoneConflicts: true }).data;
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

  async sync(operations, importId = null, importBatch = null) {
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
      const retrying = Boolean(pending);
      if (pending?.resolving) throw new Error('正在确认并取消原操作，请先继续确认待办');
      if (pending && canonicalJSON(pending.operations) !== canonicalJSON(operations)) throw new Error('存在待确认操作，请先重试原操作');
      // A reload can interrupt any sent request before its response is handled.
      // Existing pending IDs, including legacy uncertain:false records, remain uncertain.
      pending = { ...(pending || { operations, ...(importBatch ? { importBatch } : {}) }), uncertain: true };
      this.storage.setItem(key, JSON.stringify(pending));
      this.readPending(); this.loadSequence++;
      this.accountStatus.value = 'saving'; this.accountError.value = '';
      try {
        const response = await this.request('/api/v1/sync', { method: 'POST', body: JSON.stringify({ operations: pending.operations, ...(pending.importBatch ? { importBatch: pending.importBatch } : {}) }) });
        if (canonicalJSON(response.acknowledged) !== canonicalJSON(pending.operations.map(operation => operation.id))) throw new Error('云端确认单号不匹配，请重试原操作');
        if (pending.importBatch && (response.importReceipt?.signature !== pending.importBatch.signature ||
            !['pending', 'complete'].includes(response.importReceipt.status) || !Number.isInteger(response.importReceipt.count) ||
            response.importReceipt.count < 0 || response.importReceipt.count > pending.importBatch.total || response.importReceipt.total !== pending.importBatch.total)) throw new Error('云端导入进度核验失败，请重试原操作');
        await this.acceptAccount(response, generation);
        this.storage.removeItem(key); this.readPending();
        this.accountStatus.value = this.hasPending.value ? 'pending' : 'synced';
        return response;
      } catch (error) {
        // A definitive first-attempt rejection committed nothing. Uncertain retries retain their IDs.
        if (!retrying && [400, 403, 409, 413, 415, 429].includes(error.status)) this.storage.removeItem(key);
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
    const pending = JSON.parse(this.storage.getItem(this.scopedKey('pending')) || 'null');
    if (pending?.resolving) return this.resolvePending();
    if (this.pendingImport.value) return this.resumeBatchImport(onProgress);
    if (pending) return this.sync(pending.operations, null, pending.importBatch);
  }

  async resolvePending() {
    this.restoreSession();
    const generation = this.generation, key = this.scopedKey('pending');
    return this.lock('import', () => this.lock('writes', async () => {
      this.assertSession(generation);
      if (this.isLocked.value) throw new Error('请先解锁工作台');
      const pending = JSON.parse(this.storage.getItem(key) || 'null');
      if (!pending?.operations?.length) throw new Error('没有待确认的财务操作');
      pending.operations.forEach(validateOperation);
      // Resolution is itself durable and idempotent; a lost response must never
      // resume the original sync request or drop its IDs without confirmation.
      this.storage.setItem(key, JSON.stringify({ ...pending, resolving: true }));
      this.readPending(); this.loadSequence++;
      this.accountStatus.value = 'saving'; this.accountError.value = '';
      try {
        const response = await this.request('/api/v1/sync/resolve', { method: 'POST', body: JSON.stringify({ operations: pending.operations }) });
        if (!Array.isArray(response.resolved) || canonicalJSON(response.resolved.map(row => row.id)) !== canonicalJSON(pending.operations.map(op => op.id)) ||
            response.resolved.some(row => !['committed', 'cancelled'].includes(row.status))) throw new Error('云端操作确认结果无效，原操作已保留');
        await this.acceptAccount(response, generation);
        // Save import state before clearing the original pending batch, so a
        // storage failure or reload can safely repeat resolution.
        const importKey = this.scopedKey('import'), job = JSON.parse(this.storage.getItem(importKey) || 'null');
        const resolutionIds = pending.operations.map(op => op.id);
        if (job?.status === 'pending' && canonicalJSON(job.resolutionIds) !== canonicalJSON(resolutionIds)) {
          const committed = response.resolved.every(row => row.status === 'committed');
          const registeringLegacyReceipt = job.protocolVersion !== 2 && pending.importBatch && pending.importBatch.batchIndex < job.cursor;
          this.storage.setItem(importKey, JSON.stringify({ ...job, canCancel: true, resolvedBatch: !committed, resolutionIds,
            ...(committed && !registeringLegacyReceipt ? { cursor: job.cursor + 1, count: job.count + job.batches[job.cursor].count } : {}) }));
        }
        this.storage.removeItem(key); this.readPending();
        this.accountStatus.value = this.hasPending.value ? 'pending' : 'synced';
        return response;
      } catch (error) {
        if (generation === this.generation) { this.readPending(); this.accountStatus.value = 'error'; this.accountError.value = error.message; }
        throw error;
      }
    }));
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
          const member = { id: create.generated.ids[0], name: item.data.name.trim(), phone: normalizeMemberPhone(item.data.phone), balance: 0,
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
      if (job?.status === 'pending' && job.signature !== signature) throw new Error('存在未完成的导入任务，请先继续原任务');
      if (job?.status === 'complete' || job?.status === 'cancelled' && job.count > 0) this.archiveImport(job);
      const completed = this.readImportHistory()[signature];
      if (completed) {
        if (completed.status !== 'complete') throw new Error('这份数据已部分入库，请核对后仅导入剩余记录');
        if (this.storage.getItem(this.scopedKey('pending'))) throw new Error('请先确认之前的财务操作');
        if (job?.signature === signature) this.storage.setItem(key, JSON.stringify(completed));
        await this.getAccount(); this.readPending();
        return { success: true, count: completed.count, resumed: true };
      }
      if (!job || job.signature !== signature || job.status === 'cancelled') {
        if (this.storage.getItem(this.scopedKey('pending'))) throw new Error('请先确认之前的财务操作');
        const previous = await this.request('/api/v1/imports/' + signature);
        this.assertSession(generation);
        if (previous.signature !== signature || !['absent', 'pending', 'complete'].includes(previous.status) ||
            !Number.isInteger(previous.count) || previous.count < 0 || previous.count > 10000) throw new Error('云端导入历史核验失败');
        if (previous.status === 'complete') {
          if (!Number.isInteger(previous.total) || previous.total !== previous.count || !/^[a-zA-Z0-9-]{16,80}$/.test(previous.taskId || '')) throw new Error('云端导入历史核验失败');
          const completed = { id: previous.taskId, signature, status: 'complete', count: previous.count, total: previous.total };
          this.archiveImport(completed); await this.getAccount();
          return { success: true, count: previous.count, resumed: true };
        }
        if (previous.status === 'pending') throw new Error('这份数据已部分导入，请在原设备继续确认，或核对后仅导入剩余记录');
        job = { id: newId(), signature, protocolVersion: 2, status: 'pending', cursor: 0, count: 0, ...this.planImport(items, strategy, allowDebt) };
        this.storage.setItem(key, JSON.stringify(job));
      }
      return this.runImport(job, key, generation, onProgress);
    });
  }

  readImportHistory() {
    const history = JSON.parse(this.storage.getItem(this.scopedKey('import_history')) || '{}');
    if (!history || typeof history !== 'object' || Array.isArray(history) || Object.entries(history).some(([signature, job]) =>
      !/^[a-f0-9]{64}$/.test(signature) || !job || job.signature !== signature || !['complete', 'cancelled'].includes(job.status) ||
      !Number.isInteger(job.count) || job.count < 0 || job.count > 10000)) throw new Error('导入历史损坏，请保留浏览器数据并联系管理员');
    return history;
  }

  archiveImport(job) {
    const record = { id: job.id, signature: job.signature, status: job.status, count: job.count, total: job.total };
    this.storage.setItem(this.scopedKey('import_history'), JSON.stringify({ ...this.readImportHistory(), [job.signature]: record }));
  }

  importBatch(job, index) {
    return { signature: job.signature, taskId: job.id, batchIndex: index, totalBatches: job.batches.length, total: job.total, count: job.batches[index].count };
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
      const status = job.count === job.total && job.cursor === job.batches.length ? 'complete' : 'cancelled';
      if (job.count > 0) this.archiveImport({ ...job, status });
      this.storage.setItem(key, JSON.stringify({ ...job, status, batches: [] }));
      this.readPending();
    });
  }

  async runImport(job, key, generation, onProgress) {
    if (job.resolvedBatch) throw new Error('原批次的未入账操作已取消，请取消剩余导入后重新预检');
    this.importing.value = true; this.readPending();
    try {
      // Upgrade retained old tasks by replaying their confirmed operation IDs;
      // the server records receipts in the same transaction without recharging.
      if (job.protocolVersion !== 2) {
        const pending = JSON.parse(this.storage.getItem(this.scopedKey('pending')) || 'null');
        if (pending && !pending.importBatch) {
          const batch = job.batches[job.cursor];
          if (!batch || canonicalJSON(batch.operations) !== canonicalJSON(pending.operations)) throw new Error('旧导入待办与原批次不一致，请保留浏览器数据并联系管理员');
          await this.sync(batch.operations, job.id);
          job = { ...job, cursor: job.cursor + 1, count: job.count + batch.count };
          this.storage.setItem(key, JSON.stringify(job));
        }
        for (let index = job.receiptCursor || 0; index < job.cursor; index++) {
          await this.sync(job.batches[index].operations, job.id, this.importBatch(job, index));
          job = { ...job, receiptCursor: index + 1 }; this.storage.setItem(key, JSON.stringify(job));
        }
        job = { ...job, protocolVersion: 2 }; this.storage.setItem(key, JSON.stringify(job));
      }
      while (job.cursor < job.batches.length) {
        this.assertSession(generation);
        const batch = job.batches[job.cursor];
        const response = await this.sync(batch.operations, job.id, this.importBatch(job, job.cursor));
        this.assertSession(generation);
        job = { ...job, cursor: response.importReceipt?.status === 'complete' ? job.batches.length : job.cursor + 1,
          count: response.importReceipt?.count ?? job.count + batch.count, canCancel: false };
        this.storage.setItem(key, JSON.stringify(job));
        this.readPending(); onProgress(Math.round(job.count * 100 / job.total));
      }
      const completed = { id: job.id, signature: job.signature, status: 'complete', count: job.count, total: job.total };
      this.archiveImport(completed);
      this.storage.setItem(key, JSON.stringify(completed));
      this.readPending(); this.accountStatus.value = 'synced'; onProgress(100);
      return { success: true, count: job.count };
    } catch (error) {
      if ([400, 403, 409, 413, 415].includes(error.status) && !this.storage.getItem(this.scopedKey('pending'))) {
        this.storage.setItem(key, JSON.stringify({ ...job, canCancel: true })); this.readPending();
      }
      throw error;
    } finally { this.importing.value = false; }
  }

  async getVoiceConfig() {
    return this.request('/api/v1/voice/config');
  }

  async saveVoiceConfig(config) {
    return this.request('/api/v1/voice/config', {
      method: 'POST',
      body: JSON.stringify(config)
    });
  }

  async synthesizeVoice(options) {
    this.restoreSession();
    const generation = this.generation;
    const previousAccess = this.accessToken.value;
    const execute = async token => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await this.requestFetch('/api/v1/voice/synthesize', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: 'Bearer ' + token } : {})
          },
          body: JSON.stringify(options),
          signal: controller.signal
        });
        if (!response.ok) {
          let errMessage = '语音合成失败 (' + response.status + ')';
          try {
            const data = await response.json();
            errMessage = data.error || errMessage;
          } catch {}
          throw Object.assign(new Error(errMessage), { status: response.status });
        }
        return await response.blob();
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      return await execute(previousAccess);
    } catch (error) {
      if (error.status !== 401) throw error;
      this.assertSession(generation);
      if (!await this.refresh(previousAccess)) throw Object.assign(new Error('登录会话已过期，请重新登录'), { status: 401 });
      this.assertSession(generation);
      return await execute(this.accessToken.value);
    }
  }
}

export function buildAdminOperation(method, args, accountData = null, identity = null) {
  const user = identity || adminApi.identity();
  if (!user.id || !user.deviceId) throw new Error('请先登录');
  const data = accountData || adminApi.accountData.value || emptyData();
  if (['createMember', 'deleteMember', 'recharge', 'consume', 'refundLedger'].includes(method)) validateActiveMemberPhones(data.members);
  const now = new Date().toISOString(); let ids = [], times = [now];
  if (method === 'createMember') {
    ids = Number(args[0]?.initialBalance || 0) > 0 ? [newId(), newId()] : [newId()];
    if (ids.length === 2) times = [now, now];
  } else if (['recharge', 'consume', 'refundLedger'].includes(method)) ids = [newId()];
  else if (method === 'saveService' && !args[0]?.id) ids = [newId()];
  const operation = { id: newId(), method, args, actorId: user.id, deviceId: user.deviceId,
    generated: { ids, times }, precondition: mutationPrecondition(data, method, args) };
  validateOperation(operation); return operation;
}

export const adminApi = new AdminApiClient();
