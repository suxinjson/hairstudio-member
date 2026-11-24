import { batchRequest, batchScope, batchControl, bindBatch, batchStore } from '../src/relational-batches.js';
import { COMMAND_ID, invalid } from '../src/relational-contract.js';
import { requireLedgerEpoch } from '../src/ledger-epoch.js';
import { digest } from './security.js';
import { requireOperation } from './entitlements.js';

export const taskLock = (client, storeId, id) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['relational-task:' + storeId + ':' + id]);
export function postgresBatchStore(client, user, audit) {
  const query = (sql, params) => { let i = 0; return client.query(sql.replaceAll('?', () => '$' + ++i), params); };
  return batchStore({ one: async (sql, p) => (await query(sql, p)).rows[0], all: async (sql, p) => (await query(sql, p)).rows, run: query,
    receiptTable: 'application_task_receipts', hash: digest, now: () => new Date().toISOString(),
    lockTask: (store, id) => taskLock(client, store, id),
    lockBatch: (store, id) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['relational-batch:' + store + ':' + id]),
    audit: (event, details) => audit(client, user, event, details) });
}
const current = user => ({ storeId: user.store_id, ledgerEpoch: user.ledger_epoch, actorId: user.id, deviceId: user.device_id });
export function createBatchService({ withAuthorized, audit, executeTask }) {
  function authorized(identity, permission, scope, work) {
    return withAuthorized(identity, permission, async (client, user) => {
      bindBatch(scope, current(user));
      return work(postgresBatchStore(client, user, audit), client, user);
    }, { consistentRead: permission === 'read' });
  }
  return {
    captureBatch(identity, input) {
      const request = batchRequest(input), permission = request.items.some(item => item.type === 'member.archive') ? 'owner' : 'write';
      return authorized(identity, permission, request, async (store, _client, user) => {
        for (const type of new Set(request.items.map(item => item.type))) requireOperation(user.entitlements, { 'member.create': 'createMember', 'member.update': 'updateMember', 'member.archive': 'deleteMember' }[type]);
        return store.capture(request);
      });
    },
    controlBatch(identity, input) {
      const request = batchControl(input);
      return authorized(identity, 'write', request, store => store.change(request));
    },
    getBatch(identity, input, page) {
      const scope = batchScope(input);
      return authorized(identity, 'read', scope, store => store.progress(scope, page));
    },
    getBatchItem(identity, input, taskId) {
      const scope = batchScope(input);
      if (!COMMAND_ID.test(taskId ?? '')) throw invalid('行任务号无效');
      return authorized(identity, 'read', scope, store => store.task(scope, taskId));
    },
    listBatches(identity, { ledgerEpoch, after = '', limit = 50 } = {}) {
      if (after && !COMMAND_ID.test(after) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('批次分页无效');
      return withAuthorized(identity, 'read', async (client, user) => {
        requireLedgerEpoch(ledgerEpoch, user.ledger_epoch);
        const { rows } = await client.query('SELECT batch_id,created_at,source_digest,item_count FROM application_batches WHERE store_id=$1 AND actor_id=$2 AND device_id=$3 AND ledger_epoch=$4 AND batch_id>$5 ORDER BY batch_id LIMIT $6', [user.store_id, user.id, user.device_id, ledgerEpoch, after, limit + 1]);
        return { items: rows.slice(0, limit).map(row => ({ batchId: row.batch_id, createdAt: row.created_at, sourceDigest: row.source_digest, itemCount: Number(row.item_count) })), nextAfter: rows.length > limit ? rows[limit - 1].batch_id : null };
      });
    },
    async executeBatchItem(identity, input, taskId) {
      const scope = batchScope(input);
      if (!COMMAND_ID.test(taskId ?? '')) throw invalid('行任务号无效');
      const request = await authorized(identity, 'read', scope, store => store.task(scope, taskId));
      // executeTask locks task then batch, rechecks scope/state/permission inside
      // the same transaction as the actual row mutation and immutable receipt.
      return executeTask(identity, request);
    }
  };
}
