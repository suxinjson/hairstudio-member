import { DEFAULT_SERVICES } from './storage.js';
import { DATA_LIMITS, byteLength, assertJsonBudget, validateMutationArgs, assertAccountLimits } from './data-limits.js';

export const CLOUD_STATE_KEY = 'hairstudio_cloud_state_v1';
export const WRITE_METHODS = ['createMember', 'updateMember', 'deleteMember', 'recharge', 'consume',
  'refundLedger', 'saveService', 'deleteService', 'importBackupData'];
export const OWNER_METHODS = ['deleteMember', 'refundLedger', 'saveService', 'deleteService', 'importBackupData', 'bootstrap'];

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export function canWrite(role, method) {
  return role === 'owner' || (role === 'clerk' && WRITE_METHODS.includes(method) && !OWNER_METHODS.includes(method));
}

export function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => JSON.stringify(key) + ':' + canonicalJSON(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

export function mutationPrecondition(data, method, args) {
  let memberId;
  if (['recharge', 'consume'].includes(method)) memberId = args[0]?.memberId;
  if (['updateMember', 'deleteMember'].includes(method)) memberId = args[0];
  if (method === 'refundLedger') memberId = data.ledgers.find(record => record.id === args[0])?.memberId;
  if (memberId) {
    const member = data.members.find(item => item.id === memberId);
    if (!member) return { member: null };
    return { member: Object.fromEntries(['id', 'name', 'phone', 'balance', 'total_recharge', 'total_consume',
      'notes', 'created_at', 'updated_at'].map(field => [field, member[field] ?? ''])), isArchived: Boolean(member.isArchived) };
  }
  if (['saveService', 'deleteService'].includes(method)) return { services: data.services };
  if (method === 'importBackupData') return { snapshot: data };
  return {};
}

export function validateOperation(operation) {
  const restoring = operation?.method === 'importBackupData';
  assertJsonBudget(operation, restoring ? DATA_LIMITS.restoreBytes : DATA_LIMITS.operationBytes, restoring ? DATA_LIMITS.backupBytes : 16384);
  if (!operation || typeof operation.id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(operation.id) ||
      !WRITE_METHODS.includes(operation.method) || !Array.isArray(operation.args) || operation.args.length > 2 ||
      !operation.generated || !Array.isArray(operation.generated.ids) ||
      operation.generated.ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(id)) ||
      !Array.isArray(operation.generated.times) || operation.generated.times.length > 8 ||
      operation.generated.times.some(time => typeof time !== 'string' || time.length > 64 || !Number.isFinite(Date.parse(time))) ||
      typeof operation.actorId !== 'string' || operation.actorId.length > 128 ||
      typeof operation.deviceId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(operation.deviceId) ||
      !operation.precondition || typeof operation.precondition !== 'object' || Array.isArray(operation.precondition)) {
    throw new Error('同步操作格式无效');
  }
  validateMutationArgs(operation.method, operation.args);
  assertJsonBudget(operation.precondition, DATA_LIMITS.accountBytes);
  let maxIds = 3;
  if (operation.method === 'importBackupData') {
    if (typeof operation.args[0] !== 'string') throw new Error('恢复操作格式无效');
    let backup;
    try { backup = JSON.parse(operation.args[0]); } catch { throw new Error('恢复操作格式无效'); }
    assertJsonBudget(backup, DATA_LIMITS.backupBytes);
    if (operation.precondition.snapshot) assertAccountLimits(operation.precondition.snapshot);
    const services = backup?.data?.services ?? DEFAULT_SERVICES;
    if (!Array.isArray(services)) throw new Error('恢复操作格式无效');
    maxIds = operation.args[1]?.mode === 'merge' ? services.length : 0;
  }
  if (operation.generated.ids.length > maxIds) throw new Error('同步操作业务单号数量无效');
}

export function selectSyncBatch(outbox) {
  const batch = []; let size = byteLength('{"operations":[]}');
  for (const operation of outbox.slice(0, 100)) {
    validateOperation(operation);
    const restoring = operation.method === 'importBackupData';
    if (restoring && batch.length) break;
    const nextSize = size + byteLength(JSON.stringify(operation)) + (batch.length ? 1 : 0);
    const maximum = restoring ? DATA_LIMITS.restoreBytes : DATA_LIMITS.syncBytes;
    if (nextSize > maximum) {
      if (!batch.length) throw new Error('待同步操作超过单次上传限制，请导出备份并联系管理员');
      break;
    }
    batch.push(operation); size = nextSize;
    if (restoring) break;
  }
  return batch;
}
