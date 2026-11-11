import pg from 'pg';
import { readFile } from 'node:fs/promises';
export function createPool() {
  return new pg.Pool({ max: 10, connectionTimeoutMillis: 10000, statement_timeout: 30000,
    ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}) });
}
export async function migrate(pool) { await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8')); }
export async function configureRuntimeRole(pool, password) {
  if (typeof password !== 'string' || password.length < 32 || password.length > 256) throw new Error('APP_DATABASE_PASSWORD 必须为 32–256 位独立随机密码');
  await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(739186)');
    const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname='member_app'");
    if (!rows.length) await client.query('CREATE ROLE member_app LOGIN');
    await client.query('ALTER ROLE member_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT');
    const { rows: memberships } = await client.query("SELECT parent.rolname FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles child ON child.oid=m.member WHERE child.rolname='member_app'");
    for (const { rolname } of memberships) await client.query('REVOKE "' + rolname.replaceAll('"', '""') + '" FROM member_app');
    // Let PostgreSQL quote the password; do not interpolate it or print this SQL.
    const { rows: [statement] } = await client.query("SELECT format('ALTER ROLE member_app PASSWORD %L', $1::text) AS sql", [password]);
    await client.query(statement.sql);
    const { rows: [database] } = await client.query('SELECT current_database() AS name');
    const name = '"' + database.name.replaceAll('"', '""') + '"';
    await client.query('REVOKE ALL ON DATABASE ' + name + ' FROM member_app');
    await client.query('REVOKE CREATE,TEMPORARY ON DATABASE ' + name + ' FROM PUBLIC');
    await client.query('GRANT CONNECT ON DATABASE ' + name + ' TO member_app');
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await client.query('REVOKE ALL ON SCHEMA public FROM member_app');
    await client.query('GRANT USAGE ON SCHEMA public TO member_app');
    await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM member_app');
    await client.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM member_app');
    await client.query('REVOKE ALL ON stores,users,accounts,sessions,app_devices,login_limits,operations,audit_events,releases,store_settings,voice_dialogs,voice_requests,voice_device_candidates FROM PUBLIC');
    await client.query('REVOKE ALL ON SEQUENCE audit_events_id_seq FROM PUBLIC');
    await client.query('GRANT SELECT ON stores,releases TO member_app');
    await client.query('GRANT UPDATE(id) ON stores TO member_app'); // FOR UPDATE store serialization.
    await client.query('GRANT UPDATE(name,profile,profile_version) ON stores TO member_app');
    await client.query('GRANT SELECT,INSERT,UPDATE ON users,store_settings TO member_app');
    await client.query('GRANT SELECT,UPDATE ON accounts TO member_app');
    await client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON sessions,login_limits TO member_app');
    await client.query('GRANT SELECT,INSERT,UPDATE ON app_devices TO member_app');
    await client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON voice_dialogs TO member_app');
    await client.query('GRANT SELECT,INSERT,DELETE ON voice_requests TO member_app');
    await client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON voice_device_candidates TO member_app');
    await client.query('GRANT SELECT,INSERT ON operations,audit_events TO member_app');
    await client.query('GRANT USAGE ON SEQUENCE audit_events_id_seq TO member_app');
  });
}
export async function assertRuntimeRole(pool) {
  const { rows: [role] } = await pool.query("SELECT r.rolname,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls, EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS memberships, has_database_privilege(current_user,current_database(),'CREATE') AS database_create, has_database_privilege(current_user,current_database(),'TEMP') AS database_temp, has_schema_privilege(current_user,'public','CREATE') AS schema_create FROM pg_roles r WHERE r.rolname=current_user");
  if (!role || role.rolname !== 'member_app' || ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls', 'memberships', 'database_create', 'database_temp', 'schema_create'].some(key => role[key])) throw new Error('生产 API 必须使用受限的 member_app 数据库账号，请先运行迁移任务');
  const { rows } = await pool.query("SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname=current_user AND c.relnamespace='public'::regnamespace LIMIT 1");
  if (rows.length) throw new Error('运行时账号不能拥有生产数据库对象');
  const { rows: [grants] } = await pool.query("SELECT has_table_privilege(current_user,'accounts','INSERT,DELETE,TRUNCATE') OR has_table_privilege(current_user,'releases','INSERT,UPDATE,DELETE,TRUNCATE') OR has_table_privilege(current_user,'operations','UPDATE,DELETE,TRUNCATE') OR has_table_privilege(current_user,'audit_events','UPDATE,DELETE,TRUNCATE') OR has_table_privilege(current_user,'voice_requests','UPDATE,TRUNCATE') OR has_table_privilege(current_user,'voice_dialogs','TRUNCATE') AS forbidden");
  if (grants.forbidden) throw new Error('运行时账号具有超出业务所需的数据库写入权限');
}
export async function transaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
