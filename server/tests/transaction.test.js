import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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

test('a checked-out client disconnecting between statements rejects the transaction and releases its connection once', async () => {
  const client = new EventEmitter(), queries = [], releases = [];
  client.query = async sql => { queries.push(sql); };
  client.release = discard => { releases.push(discard); };
  const disconnect = new Error('database restarted while transaction callback was waiting');
  const unrelated = () => {}; client.on('error', unrelated);
  await assert.rejects(transaction({ connect: async () => client }, async () => {
    await new Promise(resolve => setImmediate(resolve));
    client.emit('error', disconnect);
    return 'must not report success';
  }), error => error === disconnect);
  assert.deepEqual(queries, ['BEGIN', 'ROLLBACK']);
  assert.deepEqual(releases, [true]);
  assert.deepEqual(client.listeners('error'), [unrelated]);
});

for (const phase of ['BEGIN', 'COMMIT']) {
  test(`a failed ${phase} cannot return a success result and releases the connection once`, async () => {
    const { pool, releases, connectionError } = fixture(phase);
    await assert.rejects(transaction(pool, async () => 42), error => error === connectionError);
    assert.deepEqual(releases, phase === 'COMMIT' ? [[true]] : [[]]);
  });
}

test('rollback-only preview returns its result only after a successful rollback and never commits', async () => {
  const { pool, queries, releases } = fixture();
  assert.equal(await transaction(pool, async client => { await client.query('PREVIEW INSERT'); return 42; }, { rollbackOnly: true }), 42);
  assert.deepEqual(queries, ['BEGIN', 'PREVIEW INSERT', 'ROLLBACK']); assert.deepEqual(releases, [[]]);
});

test('failed preview rollback cannot return the candidate result and always discards the connection', async () => {
  const { pool, queries, releases, connectionError } = fixture('ROLLBACK');
  await assert.rejects(transaction(pool, async () => 42, { rollbackOnly: true }), error => error === connectionError);
  assert.deepEqual(queries, ['BEGIN', 'ROLLBACK', 'ROLLBACK']); assert.deepEqual(releases, [[true]]);
});
