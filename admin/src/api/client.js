import { AdminApiClient, buildAdminOperation as buildOperation } from './admin-client.js';

export { AdminApiClient, ADMIN_SESSION_KEY, ADMIN_IDLE_TIMEOUT_MS } from './admin-client.js';

// Only the admin entrypoint creates this singleton. Native and cashier clients
// import the class directly so importing their modules never writes browser IDs.
export const adminApi = new AdminApiClient();

export function buildAdminOperation(method, args, accountData = null, identity = null) {
  return buildOperation(method, args, accountData || adminApi.accountData.value, identity || adminApi.identity());
}
