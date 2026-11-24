import { DATA_LIMITS, assertJsonBudget } from './data-limits.js';
import { ENTITY_ID, COMMAND_ID, memberInput, invalid } from './relational-contract.js';
import { configurationInput } from './relational-sales.js';
import { ledgerEpochOf, requireLedgerEpoch } from './ledger-epoch.js';

export const TASK_TYPES = Object.freeze(['member.create', 'member.update', 'member.archive', 'configuration.update']);
export function taskRequest(input) {
  ledgerEpochOf(input?.ledgerEpoch);
  assertJsonBudget(input, DATA_LIMITS.operationBytes);
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['id', 'storeId', 'ledgerEpoch', 'actorId', 'deviceId', 'type', 'memberId', 'data'].includes(key)) ||
      typeof input.id !== 'string' || !COMMAND_ID.test(input.id) || typeof input.storeId !== 'string' || !ENTITY_ID.test(input.storeId) ||
      !TASK_TYPES.includes(input.type) || input.actorId !== undefined && (typeof input.actorId !== 'string' || !ENTITY_ID.test(input.actorId)) ||
      input.deviceId !== undefined && (typeof input.deviceId !== 'string' || !COMMAND_ID.test(input.deviceId))) throw invalid('任务单号、归属或类型无效');
  const targetsMember = ['member.update', 'member.archive'].includes(input.type);
  if (targetsMember ? typeof input.memberId !== 'string' || !ENTITY_ID.test(input.memberId) : input.memberId !== undefined) throw invalid('任务目标无效');
  if (input.type === 'member.create') memberInput(input.data);
  else if (input.type === 'member.update') memberInput(input.data, { update: true });
  else if (input.type === 'configuration.update') configurationInput(input.data);
  else if (!input.data || typeof input.data !== 'object' || Array.isArray(input.data) || Object.keys(input.data).length) throw invalid('归档任务数据须为空对象');
  return JSON.parse(JSON.stringify(input));
}
export function bindTask(request, { storeId, ledgerEpoch, actorId, deviceId }) {
  requireLedgerEpoch(request.ledgerEpoch, ledgerEpoch);
  if (request.storeId !== storeId || request.actorId !== undefined && request.actorId !== actorId || request.deviceId !== undefined && request.deviceId !== deviceId) throw invalid('任务门店、账号或设备与当前身份不一致');
  return { ...request, actorId, deviceId };
}
export function mutationTask(type, data, metadata, memberId) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).some(key => !['id', 'storeId', 'ledgerEpoch', 'actorId', 'deviceId'].includes(key))) throw invalid('写入必须提供已持久捕获的任务标识');
  return taskRequest({ ...metadata, type, ...(memberId === undefined ? {} : { memberId }), data });
}
