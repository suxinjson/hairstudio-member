import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

// The production grant routines act on public and on fixed cluster-wide
// role names. A random schema alone cannot isolate this test.
export async function roleTestDatabase() {
  const url = new URL(process.env.MEMBER_TEST_ADMIN_DATABASE_URL);
  if (!/test/i.test(url.pathname) || process.env.MEMBER_TEST_DATABASE_DISPOSABLE !== '1') {
    throw new Error('角色测试只允许在显式标记为可丢弃的 test 集群执行');
  }
  const database = 'member_role_test_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  const pools = [];
  let created = false;
  async function close() {
    try {
      await Promise.all(pools.map(pool => pool.end()));
      if (created) {
        await admin.query('DROP DATABASE ' + database);
        await admin.query('DROP ROLE IF EXISTS member_app, member_recovery');
      }
    } finally { await admin.end(); }
  }
  try {
    // The two role suites can run concurrently against the same test service.
    await admin.query('SELECT pg_advisory_lock(171803202, 20261120)');
    const { rowCount } = await admin.query("SELECT 1 FROM pg_roles WHERE rolname IN ('member_app','member_recovery')");
    if (rowCount) throw new Error('测试集群已存在 member_app 或 member_recovery，拒绝变更现有角色');
    await admin.query('CREATE DATABASE ' + database + ' TEMPLATE template0');
    created = true;
    url.pathname = '/' + database;
    function connect(role, password) {
      const connection = new URL(url);
      if (role) { connection.username = role; connection.password = password; }
      const pool = new pg.Pool({ connectionString: connection.href, max: 4, options: '-c search_path=public', statement_timeout: 15000 });
      pools.push(pool);
      return pool;
    }
    return { pool: connect(), connect, close, password: () => randomBytes(32).toString('hex') };
  } catch (error) { await close(); throw error; }
}
