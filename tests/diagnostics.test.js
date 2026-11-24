import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics, diagnosticRoute } from '../server/diagnostics.js';
test('diagnostics batch asynchronously, sample successes, bound memory and count losses', async () => {
  const queries = [], logger = createDiagnostics({ query: async (...args) => { queries.push(args); } }, { capacity: 2, batchSize: 2, sample: () => 0.5 });
  const event = { requestId: 'request', route: 'GET /api/v1/account', status: 200, durationMs: 14 };
  logger.record(event); assert.equal(logger.snapshot().queued, 0);
  logger.record({ ...event, status: 500, errorCode: 'DATABASE_ERROR' }); logger.record({ ...event, status: 403 }); logger.record({ ...event, status: 500 });
  assert.equal(queries.length, 0); assert.equal(logger.snapshot().dropped, 1);
  await logger.flush(); assert.equal(queries.length, 1); assert.equal(queries[0][1].length, 10); assert.equal(logger.snapshot().written, 2); await logger.close();
});
test('a failed diagnostic batch drops bounded telemetry without rejecting business work', async () => {
  const logger = createDiagnostics({ query: async () => { throw new Error('database unavailable'); } });
  logger.record({ requestId: 'r', route: 'POST /api/v1/sync', status: 500, durationMs: 1 }); await logger.flush();
  assert.equal(logger.snapshot().dropped, 1); assert.equal(logger.snapshot().queued, 0); await logger.close();
  assert.equal(diagnosticRoute('GET', '/api/platform/v1/stores/customer-secret'), 'GET /api/platform/v1/stores/:id');
});
