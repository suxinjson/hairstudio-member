import { reactive, watch } from 'vue';
import { openAndroidSqlite } from './android-sqlite-driver.js';
import { createRelationalSqlite } from './relational-sqlite.js';
import { createRelationalSync } from './relational-sync.js';
import { createOnlineLedgerWrites } from './relational-online-writes.js';
import { validateFinancialCommand, COMMAND_ID, ENTITY_ID, versionOf } from './relational-contract.js';
import { taskRequest } from './relational-tasks.js';
import { ledgerEpochOf, requireLedgerEpoch } from './ledger-epoch.js';
import { canonicalJSON } from './canonical-json.js';
import { allowsFeature } from './license-policy.js';
import { replicaChunks, REPLICA_TIMEOUT_MS } from './relational-replica.js';

const fail = (message, code) => Object.assign(new Error(message), { code });
const changed = () => fail('手机使用身份或账本已变化，请在原账号下核对', 'AUTH_CONTEXT_CHANGED');
const replicaBlocks = new Set(['LEDGER_EPOCH_MISMATCH', 'LEDGER_EPOCH_REQUIRED', 'STORE_MISMATCH', 'CURSOR_AHEAD', 'CURSOR_HISTORY_INCOMPLETE']);
const keyOf = prefix => ({ storeId, actorId, deviceId }) => prefix + [storeId, actorId, deviceId].join(':');
const localKey = keyOf('hairstudio_v2_native_receipt:');
const receiptPrefixes = ['hairstudio_v2_native_receipt:', 'hairstudio_v2_pending:'];
const readers = new Set(['listMembers', 'findActiveNames', 'getMember', 'getMemberTotals', 'listLedger', 'getConfiguration', 'report', 'reportBusiness', 'reportBreakdown']);

export function createNativeWorkspace(session, { openDriver = openAndroidSqlite, storage = globalThis.localStorage, id = () => crypto.randomUUID() } = {}) {
  const auth = session.state;
  const state = reactive({ book: null, status: 'idle', error: '', pending: null, pendingError: '', busy: false, revision: 0,
    replicaReady: false, pendingCount: 0, pendingRows: [], syncStatus: 'idle', syncError: '', blockedEpoch: false, rebuildTarget: null });
  let repository, opening, reopening, connecting, refreshing, rebuilding, rebuildController, closed = false, connectionVersion = 0;
  const locks = new Map();
  const entitles = feature => allowsFeature(auth.deviceAccess.features, feature);
  function actor() {
    return !closed && auth.user && !auth.busy && auth.deviceAccess.allowed ? { storeId: auth.user.storeId, actorId: auth.user.id, deviceId: auth.deviceId } : null;
  }
  function getScope() {
    const current = actor(), book = state.book;
    return current && book && same(current, book) ? { ...current, ledgerEpoch: book.ledgerEpoch } : null;
  }
  function same(a, b) { return a && b && a.storeId === b.storeId && a.actorId === b.actorId && a.deviceId === b.deviceId; }
  function check(scope, generation = auth.generation) {
    const current = getScope(); if (auth.generation !== generation || !scope || !same(scope, current)) throw changed();
    requireLedgerEpoch(scope.ledgerEpoch, current.ledgerEpoch);
  }
  function scopedRemote(scope, generation) {
    return Object.fromEntries(Object.entries(session.remote).map(([name, method]) => [name, async (...args) => {
      check(scope, generation); const value = await method(...args); check(scope, generation); return value;
    }]));
  }
  function lock(key, action) {
    const result = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(action); locks.set(key, result);
    return result.finally(() => { if (locks.get(key) === result) locks.delete(key); });
  }
  const online = createOnlineLedgerWrites({ remote: session.remote, storage, getScope, lock, id });
  function readLocal(scope) {
    const raw = storage.getItem(localKey(scope)); if (raw === null) return null;
    try {
      const row = JSON.parse(raw);
      if (!COMMAND_ID.test(row?.id ?? '') || !['command', 'task'].includes(row.kind) || typeof row.type !== 'string' || !row.type || row.type.length > 32) throw new Error();
      ledgerEpochOf(row.ledgerEpoch); return row;
    } catch { throw fail('原本机待办记录不可读，须保留核对', 'PENDING_INVALID'); }
  }
  function foreignLocal(scope) {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(receiptPrefixes[0])) continue;
      const [storeId, actorId, deviceId] = key.slice(receiptPrefixes[0].length).split(':');
      if (storeId !== scope.storeId || deviceId !== scope.deviceId || actorId === scope.actorId) continue;
      if (!ENTITY_ID.test(actorId ?? '')) throw fail('原账号待办标识无效，请保留核对', 'PENDING_INVALID');
      const row = readLocal({ ...scope, actorId });
      if (row) return { ...row, actorId, local: true, foreignIdentity: true, generationChanged: row.ledgerEpoch !== scope.ledgerEpoch };
    }
    return null;
  }
  function pendingChanged() {
    state.pendingError = '';
    try {
      const scope = getScope(), local = scope && readLocal(scope);
      state.pending = local ? { ...local, local: true, generationChanged: local.ledgerEpoch !== scope.ledgerEpoch } : online.pending() || (scope && foreignLocal(scope));
    } catch (error) { state.pending = null; state.pendingError = error.message; }
  }
  async function useRepository() {
    if (closed) throw changed();
    if (repository?.needsReopen && !reopening) {
      const failed = repository;
      reopening = failed.close().finally(() => {
        if (repository === failed) repository = null;
        reopening = null;
      });
    }
    if (reopening) await reopening;
    if (closed) throw changed();
    if (repository) return repository;
    if (opening) return opening;
    const binding = auth.binding;
    if (!binding) throw changed();
    opening = (async () => {
      const driver = await openDriver(); let next;
      try {
        if (closed || auth.binding !== binding) throw changed();
        next = createRelationalSqlite({ driver, storeId: binding.storeId, mode: binding.mode, ledgerEpoch: binding.ledgerEpoch, authorize: session.authorize });
        await next.init();
        if (closed || auth.binding !== binding) throw changed();
        repository = next; return next;
      } catch (error) { await (next ?? driver).close().catch(() => {}); throw error; }
    })().finally(() => { opening = null; });
    return opening;
  }
  function clear() {
    connectionVersion++; state.book = null; state.status = 'idle'; state.error = ''; state.busy = false;
    state.replicaReady = false; state.pendingCount = 0; state.pendingRows = []; state.syncStatus = 'idle'; state.syncError = '';
    state.blockedEpoch = false; state.rebuildTarget = null;
    pendingChanged();
  }
  async function updateReplica(scope, generation) {
    if (auth.binding.mode !== 'cloud') return;
    check(scope, generation);
    const [snapshot, ready, blocked, rows] = await Promise.all([repository.syncState(), repository.replicaReady(), repository.replicaWriteBlock(),
      entitles('cashier') ? repository.pendingSummaries({ targetEpoch: state.rebuildTarget?.ledgerEpoch ?? null }) : []]);
    check(scope, generation);
    state.replicaReady = ready; state.pendingCount = snapshot.pendingCount; state.pendingRows = rows;
    state.blockedEpoch = Boolean(blocked);
    if (blocked) { state.syncStatus = 'blocked'; state.syncError = blocked; }
    else if (state.syncStatus === 'blocked' && replicaBlocks.has(state.syncError)) { state.syncStatus = 'idle'; state.syncError = ''; }
  }
  async function fenceReplica(scope, generation, code) {
    if (!replicaBlocks.has(code)) return;
    check(scope, generation); state.blockedEpoch = true; state.syncStatus = 'blocked'; state.syncError = code;
    await repository.blockReplicaWrites(scope.ledgerEpoch, code);
  }
  async function connect({ reopen = false } = {}) {
    if (rebuilding) return rebuilding.catch(() => {});
    const current = actor(); if (!current) return;
    const generation = auth.generation, sequence = ++connectionVersion;
    const live = () => sequence === connectionVersion && generation === auth.generation && same(actor(), current);
    state.status = 'loading'; state.error = '';
    const task = (async () => {
      try {
        if (reopen) {
          if (refreshing || state.busy || opening) throw new Error('请等待当前账本操作完成');
          const prior = repository; repository = null; state.book = null;
          await prior?.close();
        }
        if (!live()) return;
        const db = await useRepository(), book = await db.getBook(); if (!live()) return;
        state.book = { ...current, ...book };
        if (db.mode === 'cloud') await updateReplica(state.book, generation);
        else state.replicaReady = true;
        if (!live()) return;
        state.status = 'ready'; state.revision++; pendingChanged();
      } catch (error) {
        if (live()) { state.book = null; state.status = 'error'; state.error = error.message; }
      }
    })();
    connecting = task;
    try { await task; } finally { if (connecting === task) connecting = null; }
  }
  async function read(method, input) {
    const scope = getScope(), generation = auth.generation; check(scope, generation);
    if (!readers.has(method)) throw new Error('未支持的账本查询');
    if (auth.binding.mode === 'cloud' && !state.replicaReady) throw fail('请先联网完成首次账本同步', 'REPLICA_NOT_READY');
    const result = method === 'findActiveNames' && auth.binding.mode === 'cloud'
      ? await session.remote.findActiveNames({ ...input, ledgerEpoch: scope.ledgerEpoch })
      : await repository[method](input);
    check(scope, generation); return result;
  }
  async function exact(work, scope = getScope(), { allowUnknown = false } = {}) {
    const generation = auth.generation; check(scope, generation);
    if (state.busy) throw new Error('上一笔本机操作正在核对');
    if (!allowUnknown && (state.pending || state.pendingError)) throw fail('先核对原操作结果', 'PENDING_IN_PROGRESS');
    state.busy = true;
    try { const result = await work(scope, generation); check(scope, generation); state.revision++; return result; }
    finally { if (auth.generation === generation) { state.busy = false; pendingChanged(); } }
  }
  function saveOriginal(scope, input, kind) {
    const key = localKey(scope);
    const record = JSON.stringify({ id: input.id, type: input.type, kind, ledgerEpoch: scope.ledgerEpoch });
    if (storage.getItem(key) !== null) throw fail('请先核对上一次本机操作', 'PENDING_IN_PROGRESS');
    storage.setItem(key, record); if (storage.getItem(key) !== record) throw fail('原操作编号没有保存成功，尚未提交', 'PENDING_STORAGE');
    return key;
  }
  async function submit(kind, draft, scope) {
    if (!['command', 'task'].includes(kind)) throw new Error('未知账本请求');
    const result = await exact(async (current, generation) => {
      const cloud = auth.binding.mode === 'cloud';
      if (!state.replicaReady || state.blockedEpoch) throw fail('先核对账本归属和同步进度', 'REPLICA_NOT_READY');
      if (kind === 'task' && cloud) {
        if (!auth.online) throw fail('云端资料和配置需要联网确认', 'ONLINE_REQUIRED');
        return online.submit(kind, draft, current);
      }
      const input = (kind === 'command' ? validateFinancialCommand : taskRequest)({ ...draft, ...current, id: id() });
      const key = saveOriginal(current, input, kind);
      try {
        const result = await repository[kind === 'command' ? 'executeCommand' : 'executeTask'](input);
        check(current, generation); storage.removeItem(key); return result;
      } catch (error) {
        // A domain refusal has been rolled back. A failed bridge/commit can only be settled from the primary receipt.
        if (!repository.needsReopen && error.status >= 400 && error.status < 500 && error.code !== 'AUTH_CONTEXT_CHANGED') {
          check(current, generation); storage.removeItem(key);
        }
        throw error;
      }
    }, scope);
    if (auth.binding?.mode === 'cloud') {
      if (getScope()) await updateReplica(getScope(), auth.generation).catch(() => {});
      if (auth.online) void sync();
    }
    check(scope);
    return result;
  }
  async function retryPending() {
    const scope = getScope(); if (!scope) throw changed();
    let originalScope = scope, row = readLocal(scope);
    if (!row && !online.pending()) {
      const foreign = foreignLocal(scope);
      if (foreign) {
        if (auth.binding.mode !== 'standalone' || auth.user.role !== 'owner') throw fail('本机还有原账号的未明操作，请先使用原账号核对', 'PENDING_ACTOR_CHANGED');
        originalScope = { ...scope, actorId: foreign.actorId };
        row = readLocal(originalScope);
      }
    }
    if (!row) {
      const result = await exact(online.retry, scope, { allowUnknown: true });
      if (auth.binding?.mode === 'cloud' && auth.online) void sync();
      return result;
    }
    return exact(async (current, generation) => {
      requireLedgerEpoch(row.ledgerEpoch, current.ledgerEpoch);
      const db = await useRepository(); check(current, generation);
      const lookup = async () => {
        try {
          const value = await db[row.kind === 'command' ? 'getCommand' : 'getTask'](row.id, { ledgerEpoch: row.ledgerEpoch, actorId: originalScope.actorId });
          const [result, receiptId] = row.kind === 'command' ? [value, value.commandId] : [value.result, value.taskId];
          if (receiptId !== row.id || value.ledgerEpoch !== row.ledgerEpoch || value.type !== (row.type === 'reverse' ? 'reversal' : row.type)) throw fail('本机回执与原操作不符', 'RECEIPT_MISMATCH');
          return result;
        } catch (error) {
          if (error.status === 404 && error.code === (row.kind === 'command' ? 'COMMAND_NOT_FOUND' : 'TASK_NOT_FOUND')) return { uncommitted: true };
          throw error;
        }
      };
      const value = await lookup(); check(current, generation); storage.removeItem(localKey(originalScope)); return value;
    }, scope, { allowUnknown: true });
  }
  async function sync() {
    if (rebuilding) return;
    if (refreshing) return refreshing;
    if (connecting) await connecting;
    const scope = getScope(), generation = auth.generation;
    if (!scope || auth.binding.mode !== 'cloud' || !auth.online) return;
    if (refreshing) return refreshing;
    if (state.blockedEpoch) return { status: 'blocked', errorCode: state.syncError };
    state.syncStatus = 'syncing';
    refreshing = (async () => {
      let db, before;
      const wasReady = state.replicaReady;
      try {
        db = await useRepository(); check(scope, generation);
        before = await db.syncState();
        const synchronization = createRelationalSync({ repository: db, remote: scopedRemote(scope, generation) });
        const result = await synchronization.sync(); check(scope, generation);
        state.syncStatus = result.status; state.syncError = result.errorCode || '';
        await fenceReplica(scope, generation, result.errorCode);
        await updateReplica(scope, generation);
        return result;
      } catch (error) {
        if (getScope() && generation === auth.generation) {
          if (replicaBlocks.has(error.code)) await fenceReplica(scope, generation, error.code);
          else if (!state.blockedEpoch) { state.syncStatus = 'pending'; state.syncError = error.code || error.message; }
        }
      } finally {
        // Earlier pages can commit before a later network error. Publish those
        // changes too, without treating an unchanged heartbeat as a mutation.
        if (db && before && generation === auth.generation && getScope()) {
          try {
            const after = await db.syncState(); check(scope, generation);
            if (before.cursor !== after.cursor || before.pendingCount !== after.pendingCount || wasReady !== state.replicaReady) state.revision++;
          } catch (error) {
            if (generation === auth.generation && getScope() && !state.blockedEpoch) {
              state.syncStatus = 'pending'; state.syncError = error.code || error.message;
            }
          }
        }
      }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function inspectOriginal(commandId) {
    if (refreshing) await refreshing;
    const scope = getScope(), generation = auth.generation; check(scope, generation);
    if (auth.binding.mode !== 'cloud' || !auth.online) throw fail('请联网后按原号查询', 'ONLINE_REQUIRED');
    const synchronization = createRelationalSync({ repository, remote: scopedRemote(scope, generation) });
    const result = await synchronization.inspectOriginal(commandId); check(scope, generation);
    await fenceReplica(scope, generation, result.errorCode);
    if (result.status === 'confirmed') { await updateReplica(scope, generation); state.revision++; await sync(); }
    return result;
  }
  async function currentCloudBook(scope, generation) {
    check(scope, generation);
    if (auth.binding.mode !== 'cloud' || !auth.online || !state.blockedEpoch || state.syncError === 'STORE_MISMATCH') {
      throw fail('请联网核对被暂停的同店云端账本', 'REPLICA_REBUILD_BLOCKED');
    }
    const target = await scopedRemote(scope, generation).getBook();
    if (target.storeId !== scope.storeId) throw fail('不能使用其他门店的账本重建', 'STORE_MISMATCH');
    return target;
  }
  async function prepareRebuild() {
    const scope = getScope(), generation = auth.generation, target = await currentCloudBook(scope, generation);
    state.rebuildTarget = target; await updateReplica(scope, generation); return target;
  }
  async function savePendingReview(id, resolution, targetEpoch, documents) {
    return exact(async (scope, generation) => {
      const target = await currentCloudBook(scope, generation); requireLedgerEpoch(targetEpoch, target.ledgerEpoch);
      const input = { id, resolution, targetEpoch }, content = await repository.pendingReviewDocument(input);
      check(scope, generation);
      const result = await documents.save({ content, fileName: 'member-pending-' + id + '.json' });
      check(scope, generation);
      if (result?.status !== 'saved-verified') return { reviewed: false };
      const checkedTarget = await currentCloudBook(scope, generation); requireLedgerEpoch(targetEpoch, checkedTarget.ledgerEpoch);
      const review = await repository.recordPendingReview({ ...input, sha256: result.sha256 });
      await updateReplica(scope, generation); return review;
    }, undefined, { allowUnknown: true });
  }
  function hasUnknownReceipt(scope) {
    if (state.pending || state.pendingError) return true;
    for (let i = 0; i < storage.length; i++) {
      const [prefix, store, , device] = storage.key(i)?.split(':') ?? [];
      if (receiptPrefixes.includes(prefix + ':') && store === scope.storeId && device === scope.deviceId) return true;
    }
    return false;
  }
  async function rebuildReplica(targetEpoch) {
    if (refreshing) await refreshing;
    if (state.busy || rebuilding || connecting) throw fail('请等当前账本操作完成', 'REPLICA_REBUILD_BUSY');
    const scope = getScope(), generation = auth.generation; check(scope, generation);
    if (auth.user.role !== 'owner') throw fail('只有店主可以重建本机副本', 'FORBIDDEN');
    if (hasUnknownReceipt(scope)) throw fail('请先用原账号核对尚未确认的操作回执', 'PENDING_IN_PROGRESS');
    const controller = new AbortController(); rebuildController = controller; state.busy = true;
    const checkpoint = () => {
      check(scope, generation);
      if (controller.signal.aborted) throw fail('已取消本机副本重建', 'REQUEST_ABORTED');
    };
    const verifyTarget = async cursor => {
      checkpoint();
      const latest = await scopedRemote(scope, generation).getExportWatermark({ ledgerEpoch: targetEpoch }, { signal: controller.signal });
      if (latest?.storeId !== scope.storeId) throw fail('不能使用其他门店的账本重建', 'STORE_MISMATCH');
      requireLedgerEpoch(targetEpoch, latest.ledgerEpoch);
      if (BigInt(versionOf(latest.cursor, '云端当前水位')) < BigInt(cursor)) {
        throw fail('云端当前水位低于副本水位，请重新核对', 'REPLICA_SNAPSHOT_INVALID');
      }
      checkpoint();
    };
    rebuilding = (async () => {
      const target = await currentCloudBook(scope, generation); requireLedgerEpoch(targetEpoch, target.ledgerEpoch);
      const db = await useRepository(); checkpoint();
      const result = await session.requestStream('/api/v2/sync/snapshot?ledgerEpoch=' + encodeURIComponent(targetEpoch), async response => {
        try {
          if (!/^application\/x-ndjson(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw fail('云端没有返回可重建的副本', 'REPLICA_SNAPSHOT_INVALID');
          return await db.rebuildReplica({ sourceEpoch: scope.ledgerEpoch, targetEpoch, chunks: replicaChunks(response.body), checkpoint, verifyTarget });
        } finally {
          if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
        }
      }, { signal: controller.signal }, REPLICA_TIMEOUT_MS + 5000);
      check(scope, generation);
      if (result.storeId !== scope.storeId || result.ledgerEpoch !== targetEpoch) throw changed();
      state.book = { ...scope, ledgerEpoch: result.ledgerEpoch }; state.rebuildTarget = null;
      state.syncStatus = 'idle'; state.syncError = '';
      await updateReplica(state.book, generation); state.revision++; pendingChanged(); return result;
    })();
    try { return await rebuilding; }
    catch (error) {
      if (auth.generation === generation && (replicaBlocks.has(error.code) || error.code === 'REPLICA_SNAPSHOT_INVALID')) {
        state.rebuildTarget = null;
      }
      throw error;
    }
    finally {
      const needsReopen = repository?.needsReopen;
      rebuilding = null; rebuildController = null;
      if (auth.generation === generation) state.busy = false;
      if (actor() && (needsReopen || !getScope())) await connect();
    }
  }
  const batch = {
    async listBatches(input) { const scope = getScope(), started = auth.generation; check(scope, started); const target = batchTarget();
      const result = await target.listBatches({ ...input, ledgerEpoch: scope.ledgerEpoch }); check(scope, started); return result; },
    async executeBatchItems(scope, options) {
      const started = auth.generation; check(scope, started); const target = batchTarget();
      if (target.executeBatchItems) {
        try { const result = await target.executeBatchItems(scope, options); check(scope, started); return result; }
        finally { if (auth.generation === started) { state.revision++; void sync(); } }
      }
      for (const id of options.taskIds) {
        if (options.signal?.aborted) break;
        await batch.executeBatchItem(scope, id);
      }
    }
  };
  function batchTarget() {
    if (auth.binding.mode === 'cloud') {
      if (!auth.online || state.blockedEpoch) throw fail('请联网核对当前账本后使用云端批次', 'ONLINE_REQUIRED');
      return session.remote;
    }
    return repository;
  }
  for (const name of ['captureBatch', 'getBatch', 'controlBatch', 'getBatchItem', 'executeBatchItem']) {
    batch[name] = async (scope, extra) => {
      const generation = auth.generation; check(scope, generation);
      const result = await batchTarget()[name](scope, extra); check(scope, generation);
      if (name === 'executeBatchItem') { state.revision++; if (auth.binding.mode === 'cloud') void sync(); }
      return result;
    };
  }
  const stopAuth = watch(() => canonicalJSON([actor(), auth.generation, auth.user?.role ?? null]), () => {
    rebuildController?.abort(); clear(); if (actor()) void connect().then(() => sync());
  }, { flush: 'post' });
  return { state, storage, lock, batch, getScope, connect, read, submit, retryPending,
    reviewOpenings: (input, scope) => exact(async () => (await useRepository()).previewOpeningImport(input), scope),
    importOpenings: (input, scope) => exact(async () => (await useRepository()).importOpeningBalances(input), scope),
    get mode() { return auth.binding?.mode; },
    get repository() { return repository; },
    async recoverConnection() {
      const scope = getScope(), generation = auth.generation; check(scope, generation);
      const db = await useRepository(); check(scope, generation); return db;
    },
    acknowledgeRejected: id => exact(() => online.acknowledgeRejected(id), undefined, { allowUnknown: true }),
    archiveObsolete: (id, target, save) => exact((scope, generation) => online.archiveObsolete(id, target, save, () => check(scope, generation)), undefined, { allowUnknown: true }),
    async pendingDetails(id) { const scope = getScope(), generation = auth.generation; check(scope, generation);
      const detail = await repository.pendingDetails(id); check(scope, generation); return detail; },
    sync, inspectOriginal, prepareRebuild, savePendingReview, rebuildReplica,
    cancelRebuild: () => rebuildController?.abort(),
    async dispose() { stopAuth(); closed = true; rebuildController?.abort(); clear(); await rebuilding?.catch(() => {}); await reopening?.catch(() => {}); await opening?.catch(() => {}); await repository?.close(); }
  };
}
