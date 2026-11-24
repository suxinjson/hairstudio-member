import { canonicalJSON } from '../src/canonical-json.js';
import { bindTask, mutationTask } from '../src/relational-tasks.js';
import { ApiError, digest } from './security.js';
import { requireOperation } from './entitlements.js';
import { postgresBatchStore, taskLock } from './relational-batches.js';

export function createTaskRunner({ withAuthorized, audit }) {
  return function withTask(identity, permission, operation, type, data, metadata, memberId, work) {
    const request = mutationTask(type, data, metadata, memberId);
    return withAuthorized(identity, permission, async (client, user) => {
      requireOperation(user.entitlements, operation);
      const bound = bindTask(request, { storeId: user.store_id, ledgerEpoch: user.ledger_epoch, actorId: user.id, deviceId: user.device_id }), requestHash = digest(canonicalJSON(bound));
      // Lock the task, not its target. The same ID may race different members
      // or task types and must still have only one committed result.
      await taskLock(client, user.store_id, request.id);
      const { rows: [prior] } = await client.query('SELECT request_hash,actor_id,device_id,ledger_epoch,result FROM application_task_receipts WHERE store_id=$1 AND task_id=$2', [user.store_id, request.id]);
      if (prior) {
        if (prior.ledger_epoch !== bound.ledgerEpoch) throw new ApiError(409, '任务属于其他或未标记代际，须保留并核对', 'LEDGER_EPOCH_MISMATCH');
        if (prior.request_hash !== requestHash || prior.actor_id !== user.id || prior.device_id !== user.device_id) throw new ApiError(409, '同任务号对应不同内容、账号或设备', 'TASK_CONFLICT');
        return prior.result;
      }
      await postgresBatchStore(client, user, audit).guardTask(bound, requestHash);
      const result = await work(client, user);
      await client.query('INSERT INTO application_task_receipts(store_id,task_id,actor_id,device_id,request_hash,task_type,entity_id,result,ledger_epoch) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [user.store_id, request.id, user.id, user.device_id, requestHash, request.type, request.memberId ?? result.id ?? 'store', result, bound.ledgerEpoch]);
      await audit(client, user, 'task_completed', { taskId: request.id, type: request.type });
      return result;
    });
  };
}
