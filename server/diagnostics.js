// Bounded, lossy diagnostics. Financial/security audit records use separate,
// durable transactions and must never pass through this queue.
export function createDiagnostics(pool, { capacity = 2000, batchSize = 100, intervalMs = 2000, sample = Math.random } = {}) {
  let queue = [], dropped = 0, written = 0, pending = null, closed = false;
  const timer = setInterval(() => { void flush(); }, intervalMs); timer.unref?.();
  function record(event) {
    if (closed || event.status < 400 && sample() >= 0.01) return;
    if (queue.length >= capacity) { dropped++; return; }
    queue.push({ requestId: String(event.requestId).slice(0, 36), route: String(event.route).slice(0, 160), status: Math.min(599, Math.max(100, Math.trunc(event.status) || 500)), duration: Math.min(2147483647, Math.max(0, Math.trunc(event.durationMs) || 0)), code: /^[A-Z0-9_]{1,64}$/.test(event.errorCode || '') ? event.errorCode : null });
  }
  async function flush() {
    if (pending) return pending;
    if (!queue.length) return;
    const batch = queue.splice(0, batchSize);
    pending = (async () => {
      const values = [], tuples = batch.map((event, index) => {
        const offset = index * 5; values.push(event.requestId, event.route, event.status, event.duration, event.code);
        return '(' + [1, 2, 3, 4, 5].map(n => '$' + (offset + n)).join(',') + ')';
      });
      try { await pool.query('INSERT INTO diagnostic_events(request_id,route,status,duration_ms,error_code) VALUES ' + tuples.join(','), values); written += batch.length; }
      catch { dropped += batch.length; }
    })().finally(() => { pending = null; });
    return pending;
  }
  return { record, flush, snapshot: () => ({ queued: queue.length, dropped, written, capacity, successSampleRate: 0.01 }),
    async close() { closed = true; clearInterval(timer); if (pending) await pending; while (queue.length) await flush(); } };
}
export function diagnosticRoute(method, path) {
  // Never capture query strings, request bodies, credentials or raw identifiers.
  if (path === '/api/v2/exports/ledger' || /^\/api\/v2\/exports\/ledger\/[0-9a-f-]{36}\/(file|discard)$/.test(path)) {
    return String(method).slice(0, 10) + ' ' + path.replace(/\/[0-9a-f-]{36}\//, '/:id/');
  }
  const names = new Set(['', 'api', 'v1', 'platform', 'auth', 'login', 'logout', 'refresh', 'password', 'me', 'stores', 'store', 'users', 'operators', 'license', 'offline-licenses', 'logs', 'system', 'health', 'ready', 'devices', 'device', 'authorization', 'profile', 'account', 'bootstrap', 'head', 'reconcile', 'sync', 'resolve', 'imports', 'activity', 'voice', 'aligenie', 'config', 'synthesize', 'updates', 'latest', 'files']);
  return String(method).slice(0, 10) + ' ' + path.split('/').map(part => names.has(part) ? part : ':id').join('/').slice(0, 140);
}
