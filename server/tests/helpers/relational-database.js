import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { migrate } from '../../database.js';

export async function relationalTestDatabase() {
  const connectionString = process.env.MEMBER_RELATIONAL_TEST_DATABASE_URL;
  let pool, close, engine;
  if (connectionString) {
    const url = new URL(connectionString);
    if (!/test/i.test(url.pathname) || process.env.MEMBER_TEST_DATABASE_DISPOSABLE !== '1') throw new Error('关系化数据库测试只接受名称含 test 的专用库，并须设置 MEMBER_TEST_DATABASE_DISPOSABLE=1');
    const schema = 'relational_test_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Pool({ connectionString });
    await admin.query('CREATE SCHEMA ' + schema);
    pool = new pg.Pool({ connectionString, max: 12, options: '-c search_path=' + schema, statement_timeout: 15000, lock_timeout: 10000 });
    close = async () => { await pool.end(); try { await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); } finally { await admin.end(); } };
    engine = 'PostgreSQL (dedicated schema, multiple connections)';
  } else {
    const db = new PGlite(); let tail = Promise.resolve();
    pool = {
      async connect() {
        const previous = tail; let release; tail = new Promise(resolve => { release = resolve; }); await previous;
        return { query: (sql, params) => params ? db.query(sql, params) : sql.includes(';') ? db.exec(sql) : db.query(sql), release };
      },
      async query(sql, params) { const client = await this.connect(); try { return await client.query(sql, params); } finally { client.release(); } }
    };
    close = () => db.close(); engine = 'PGlite (serialized logic only; not PostgreSQL concurrency acceptance)';
  }
  try { await migrate(pool); } catch (error) { await close(); throw error; }
  return { pool, close, engine, version: (await pool.query('SELECT version() AS version')).rows[0].version };
}
