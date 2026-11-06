import { createLocalDb, localDb, configureCloudWrites, STORAGE_KEYS } from './storage.js';
import { CLOUD_STATE_KEY, canWrite, mutationPrecondition, canonicalJSON, validateOperation, newId } from './sync-protocol.js';
import { assertLedgerAccess } from './ledger-access.js';

export function getCloudState(storage = globalThis.localStorage) {
  if (storage === globalThis.localStorage) assertLedgerAccess();
  const raw = storage.getItem(CLOUD_STATE_KEY);
  if (raw === null) return { serverUrl: '', binding: null, user: null, revision: 0, outbox: [], activity: [], status: 'local' };
  const state = JSON.parse(raw);
  if (!state || !Array.isArray(state.outbox) || !Array.isArray(state.activity) ||
      (state.binding && (typeof state.binding.storeId !== 'string' || !state.serverUrl || typeof state.deviceId !== 'string')) ||
      (state.user && !['owner', 'clerk', 'viewer'].includes(state.user.role)) ||
      (state.cloudAdoption && (!Number.isSafeInteger(state.cloudAdoption.cursor) || state.cloudAdoption.cursor < 0 ||
        state.cloudAdoption.cursor > state.outbox.length || typeof state.cloudAdoption.bootstrapResolved !== 'boolean' ||
        typeof state.cloudAdoption.actorId !== 'string' || !Number.isSafeInteger(state.cloudAdoption.revision) ||
        state.cloudAdoption.revision < 0 || !/^[a-f0-9]{64}$/.test(state.cloudAdoption.integrity || '')))) throw new Error('云端同步记录损坏，请保留本地账本并联系支持');
  return state;
}

export function saveCloudState(state, storage = globalThis.localStorage) {
  if (storage === globalThis.localStorage) assertLedgerAccess();
  storage.setItem(CLOUD_STATE_KEY, JSON.stringify(state));
}

export function installCloudRecording(onChange = () => {}, { allowLocal = () => true } = {}) {
  const stopRecording = configureCloudWrites((entries, mutation) => {
    const state = getCloudState();
    if (state.cloudAdoption) throw new Error('正在核对并采用云端账本，请先在云端设置中完成核对');
    if (!state.binding) {
      if (state.user && !canWrite(state.user.role, mutation.method)) throw new Error('当前账号没有此操作权限');
      if (!allowLocal()) throw new Error('请先登录并完成云端账本加载与绑定，再进行记账');
      return entries;
    }
    if (!state.user) throw new Error('请先登录已绑定的云端账号');
    if (!canWrite(state.user.role, mutation.method)) throw new Error('当前账号没有此操作权限');
    let current;
    try { current = localDb.readBackupState(); }
    catch (error) {
      if (mutation.method !== 'importBackupData' || (mutation.args[1]?.mode || 'replace') !== 'replace') throw error;
      // 损坏数据不能作为服务端恢复的前置条件。先恢复本机，保留原待办供店主联网后核对。
      return { ...entries,
        [STORAGE_KEYS.SAFETY_SNAPSHOT]: { timestamp: new Date().toISOString(), ...localDb.readRecoveryState(), cloud: state },
        [CLOUD_STATE_KEY]: { ...state, status: 'conflict', conflictReason: 'recovery' }
      };
    }
    if (state.status === 'conflict' || state.conflictReason === 'integrity') throw new Error('账本存在同步冲突，请先在云端设置中处理');
    const operation = {
      ...mutation, id: newId(), actorId: state.user.id, deviceId: state.deviceId,
      precondition: mutationPrecondition(current, mutation.method, mutation.args)
    };
    validateOperation(operation);
    const next = { ...state, outbox: [...state.outbox, operation], status: 'pending' };
    return { ...entries, [CLOUD_STATE_KEY]: next };
  }, onChange);
  return stopRecording;
}

export function replayOperation(data, operation) {
  validateOperation(operation);
  const current = mutationPrecondition(data, operation.method, operation.args);
  // 旧版待办没有赠送设置前置条件；仅在门店还未设置新规则时继续兼容。
  if (operation.method === 'recharge' && !Object.hasOwn(operation.precondition, 'rechargeSettings') && data.rechargeSettings === undefined) delete current.rechargeSettings;
  if (canonicalJSON(current) !== canonicalJSON(operation.precondition)) {
    throw new Error('该会员或设置已被其他设备修改，需要核对账本后处理同步冲突');
  }
  const values = new Map(Object.entries({
    [STORAGE_KEYS.MEMBERS]: data.members, [STORAGE_KEYS.LEDGERS]: data.ledgers,
    [STORAGE_KEYS.SERVICES]: data.services, [STORAGE_KEYS.RECHARGE_PLANS]: data.rechargePlans
  }).map(([key, value]) => [key, JSON.stringify(value)]));
  if (data.rechargeSettings !== undefined) values.set(STORAGE_KEYS.RECHARGE_SETTINGS, JSON.stringify(data.rechargeSettings));
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const ids = [...operation.generated.ids];
  const times = [...operation.generated.times];
  const db = createLocalDb(storage, {
    generateId(prefix) {
      if (prefix === 'SNP') return 'SNP' + crypto.randomUUID();
      if (!ids.length) throw new Error('同步操作缺少业务单号');
      return ids.shift();
    },
    now() { return times.shift() || operation.generated.times.at(-1); }
  });
  const result = db[operation.method](...operation.args);
  if (ids.length) throw new Error('同步操作业务单号数量不一致');
  return { data: db.readBackupState(), result };
}
