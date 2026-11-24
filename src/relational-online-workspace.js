import { reactive, watch } from 'vue';
import { createRelationalRemote } from './relational-remote.js';
import { createOnlineLedgerWrites } from './relational-online-writes.js';
import { requireLedgerEpoch } from './ledger-epoch.js';

const lostContext = () => Object.assign(new Error('登录身份已变化，请重新打开页面核对'), { code: 'AUTH_CONTEXT_CHANGED' });
const sameActor = (a, b) => a && b && a.storeId === b.storeId && a.actorId === b.actorId && a.deviceId === b.deviceId;

// An online page holds a single account/device/generation and bounded query
// results. It never materializes a store snapshot or exposes a synchronous DB.
export function createOnlineWorkspace(api, { eventTarget = globalThis.window } = {}) {
  const remote = createRelationalRemote({ request: (...args) => api.request(...args) });
  const state = reactive({ book: null, status: 'idle', error: '', pending: null, pendingError: '', busy: false, revision: 0 });
  let generation = 0, connectSequence = 0, disposed = false;
  function actor() {
    const user = api.user.value;
    return user && !api.isLocked.value && !disposed ? { storeId: user.storeId, actorId: user.id, deviceId: api.deviceId } : null;
  }
  function getScope() {
    const current = actor(), book = state.book;
    return book && sameActor(current, book) ? { ...current, ledgerEpoch: book.ledgerEpoch } : null;
  }
  const writes = createOnlineLedgerWrites({ remote, storage: api.storage, getScope, lock: (...args) => api.lock(...args) });
  function pendingChanged() {
    state.pendingError = '';
    try { state.pending = writes.pending(); }
    catch (error) { state.pending = null; state.pendingError = error.message; }
  }
  function invalidate() {
    generation++; state.book = null; state.status = 'idle'; state.error = ''; state.busy = false; pendingChanged();
  }
  function check(original, started) {
    const current = getScope();
    if (generation !== started || !sameActor(current, original)) throw lostContext();
    requireLedgerEpoch(original.ledgerEpoch, current.ledgerEpoch);
  }
  function needsHandshake(error, started) {
    if (started === generation && error.code === 'LEDGER_EPOCH_MISMATCH') {
      invalidate(); state.status = 'error'; state.error = '账本已换代。请刷新并按原代际核对任何未确认请求。';
    }
  }
  async function connect() {
    api.restoreSession();
    const current = actor(), started = generation, sequence = ++connectSequence;
    if (!current) return;
    state.status = 'loading'; state.error = '';
    try {
      const book = await remote.getBook();
      if (started !== generation || sequence !== connectSequence || !sameActor(current, actor())) return;
      if (book.storeId !== current.storeId) throw lostContext();
      if (state.book?.ledgerEpoch !== book.ledgerEpoch) { generation++; state.busy = false; }
      state.book = { ...current, ledgerEpoch: book.ledgerEpoch }; state.revision++;
      state.status = 'ready'; pendingChanged();
    } catch (error) {
      if (started === generation && sequence === connectSequence) {
        invalidate(); state.status = 'error'; state.error = error.message;
      }
    }
  }
  async function read(method, ...args) {
    api.restoreSession();
    const scope = getScope(), started = generation;
    if (!scope) throw lostContext();
    const [input, query] = args, epoch = { ledgerEpoch: scope.ledgerEpoch };
    try {
      const result = method === 'getMember' ? await remote[method](input, { ...query, ...epoch }) : await remote[method]({ ...input, ...epoch });
      check(scope, started);
      return result;
    } catch (error) { needsHandshake(error, started); throw error; }
  }
  async function exact(action, scope = getScope()) {
    api.restoreSession();
    const started = generation;
    if (!scope) throw lostContext();
    check(scope, started);
    if (state.busy) throw new Error('上一笔操作正在确认');
    state.busy = true;
    try {
      const result = await action(); check(scope, started); state.revision++;
      return result;
    } catch (error) { needsHandshake(error, started); throw error; }
    finally { if (started === generation) { state.busy = false; pendingChanged(); } }
  }
  const sessionKey = () => JSON.stringify([actor(), api.user.value?.role ?? null, api.generation]);
  const stopSession = watch(sessionKey, () => { invalidate(); if (actor()) void connect(); }, { flush: 'post' });
  const storageChanged = event => { if (event.key === null || event.key?.startsWith('hairstudio_v2_pending:')) pendingChanged(); };
  eventTarget?.addEventListener('storage', storageChanged);
  const batch = { listBatches: input => read('listBatches', input) };
  for (const method of ['captureBatch', 'getBatch', 'controlBatch', 'getBatchItem', 'executeBatchItem', 'executeBatchItems']) {
    batch[method] = async (scope, extra) => {
      api.restoreSession(); const started = generation; check(scope, started);
      try { const result = await remote[method](scope, extra); check(scope, started); return result; }
      catch (error) { needsHandshake(error, started); throw error; }
    };
  }
  return {
    state, remote, getScope, connect, read, batch, mode: 'online', storage: api.storage, lock: (...args) => api.lock(...args),
    submit: (kind, draft, scope) => exact(() => writes.submit(kind, draft, scope), scope),
    retryPending: () => exact(writes.retry),
    acknowledgeRejected: id => exact(() => writes.acknowledgeRejected(id)),
    archiveObsolete: (id, target, save) => {
      const scope = getScope(), started = generation;
      return exact(() => writes.archiveObsolete(id, target, save, () => check(scope, started)), scope);
    },
    reviewOpenings: (input, scope) => exact(() => remote.previewOpeningImport(input), scope),
    importOpenings: (input, scope) => exact(() => {
      if (state.pending || state.pendingError) throw new Error('请先核对原操作结果');
      return remote.importOpeningBalances(input);
    }, scope),
    dispose() { disposed = true; stopSession(); eventTarget?.removeEventListener('storage', storageChanged); invalidate(); }
  };
}
