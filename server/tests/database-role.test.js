import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate, configureRuntimeRole, assertRuntimeRole } from '../database.js';
import { createService } from '../service.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

test('migration preserves existing accounts and runtime grants support business work while denying administrator actions', async () => {
  let db, query, cleanup;
  if (process.env.MEMBER_TEST_ADMIN_DATABASE_URL) {
    const database = 'member_role_test_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Pool({ connectionString: process.env.MEMBER_TEST_ADMIN_DATABASE_URL });
    const { rows: existing } = await admin.query("SELECT 1 FROM pg_roles WHERE rolname='member_app'");
    if (existing.length) { await admin.end(); throw new Error('角色测试必须使用没有 member_app 的专用临时 PostgreSQL 集群，拒绝修改现有角色'); }
    await admin.query('CREATE DATABASE ' + database);
    const connection = new URL(process.env.MEMBER_TEST_ADMIN_DATABASE_URL); connection.pathname = '/' + database;
    const databasePool = new pg.Pool({ connectionString: connection.href });
    const client = await databasePool.connect(); query = (...args) => client.query(...args);
    cleanup = async () => {
      client.release(); await databasePool.end();
      try { await admin.query('DROP DATABASE ' + database); await admin.query('DROP ROLE IF EXISTS member_app'); } finally { await admin.end(); }
    };
  } else {
    db = new PGlite();
    query = (sql, parameters) => parameters ? db.query(sql, parameters) : sql.includes(';') ? db.exec(sql) : db.query(sql);
    cleanup = () => db.close();
  }
  const pool = { query, connect: async () => ({ query, release() {} }) };
  try {
    await migrate(pool);
    const administrator = (await query('SELECT current_user AS name')).rows[0].name;
    const service = createService(pool), password = 'Correct-Horse-Cloud-2026!';
    const created = await service.createOwner({ username: 'owner', password });
    await configureRuntimeRole(pool, 'x'.repeat(48));
    await migrate(pool); await configureRuntimeRole(pool, 'x'.repeat(48));
    await assert.rejects(assertRuntimeRole(pool));
    await query('SET ROLE member_app'); await assertRuntimeRole(pool);
    const session = await service.login({ username: 'owner', password, deviceId: randomUUID() }, '127.0.0.1');
    const identity = await service.authenticate(session.accessToken);
    assert.equal(identity.store_id, created.storeId);
    const data = (await service.account(identity)).data;
    await service.bootstrap(identity, { id: randomUUID(), data });
    const next = await service.createUser(identity, { username: 'clerk', password, displayName: '店员', role: 'clerk' });
    await service.updateUser(identity, next.id, { active: false, role: 'viewer' });
    await service.refresh(session.refreshToken);
    await service.auditLog(identity); await query('SELECT * FROM releases');
    for (const sql of ['CREATE TABLE forbidden(id int)', 'CREATE ROLE forbidden_role', 'CREATE DATABASE forbidden_db', 'DROP TABLE accounts', 'TRUNCATE accounts', 'DELETE FROM accounts', "UPDATE releases SET notes='forged'", 'GRANT "' + administrator.replaceAll('"', '""') + '" TO member_app', "COPY stores TO PROGRAM 'echo forbidden'"]) {
      await assert.rejects(query(sql), { code: '42501' });
    }
    await query('RESET ROLE');
    assert.equal((await query('SELECT count(*)::int AS count FROM stores')).rows[0].count, 1);
  } finally { await cleanup(); }
});
