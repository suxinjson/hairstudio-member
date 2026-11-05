import { adminApi, buildAdminOperation } from '../api/client.js';
import { canonicalJSON } from '../../../src/sync-protocol.js';
import { watch } from 'vue';

export function useOperationSubmission(submitOperations) {
  let retained = null;
  watch(adminApi.pendingOperation, pending => { if (!pending) retained = null; }, { flush: 'sync' });
  return async (method, args, data) => {
    if (!retained || canonicalJSON([retained.method, retained.args]) !== canonicalJSON([method, args])) {
      retained = buildAdminOperation(method, args, data);
    }
    try {
      const result = await submitOperations([retained]);
      retained = null;
      return result;
    } catch (error) {
      // Network uncertainty keeps the original operation even if the account is manually refreshed.
      if (!adminApi.hasPending.value) retained = null;
      throw error;
    }
  };
}
