import test from 'node:test';
import assert from 'node:assert/strict';
import { transaction } from '../database.js';

function fixture(failAt) {
  const queries = [], releases = [];
  const connectionError = new Error('connection lost');
  const client = {
    async query(sql) { queries.push(sql); if (sql === failAt) throw connectionError; },
    release(...args) { releases.push(args); }
  };
  return { pool: { connect: async () => client }, queries, releases, connectionError };
}

test('committed transactions and successful rollbacks release reusable connections exactly once', async () => {
  const success = fixture();
  assert.equal(await transaction(success.pool, async client => { await client.query('WRITE'); return 42; }), 42);
  assert.deepEqual(success.queries, ['BEGIN', 'WRITE', 'COMMIT']);
  assert.deepEqual(success.releases, [[]]);
  const failure = fixture(), error = new Error('business conflict');
  await assert.rejects(transaction(failure.pool, async () => { throw error; }), actual => actual === error);
  assert.deepEqual(failure.queries, ['BEGIN', 'ROLLBACK']);
  assert.deepEqual(failure.releases, [[]]);
});

test('a failed rollback destroys the connection and preserves the original request error', async () => {
  const { pool, queries, releases } = fixture('ROLLBACK');
  const conflict = Object.assign(new Error('ledger changed'), { status: 409, code: 'SYNC_CONFLICT' });
  await assert.rejects(transaction(pool, async client => { await client.query('WRITE'); throw conflict; }), error => error === conflict);
  assert.deepEqual(queries, ['BEGIN', 'WRITE', 'ROLLBACK']);
  assert.deepEqual(releases, [[true]]);
});

for (const phase of ['BEGIN', 'COMMIT']) {
  test(`a failed ${phase} cannot return a success result and releases the connection once`, async () => {
    const { pool, releases, connectionError } = fixture(phase);
    await assert.rejects(transaction(pool, async () => 42), error => error === connectionError);
    assert.deepEqual(releases, [[]]);
  });
}
