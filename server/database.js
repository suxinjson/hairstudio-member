import pg from 'pg';
import { readFile } from 'node:fs/promises';
export function createPool(connectionString = process.env.DATABASE_URL, { max } = {}) {
  const setting = (name, fallback, min, max) => {
    const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(name + ' 配置超出允许范围'); return value;
  };
  return new pg.Pool({ max: max ?? setting('DB_POOL_MAX', 10, 1, 100), connectionTimeoutMillis: setting('DB_CONNECT_TIMEOUT_MS', 5000, 100, 30000),
    statement_timeout: setting('DB_STATEMENT_TIMEOUT_MS', 15000, 1000, 60000), lock_timeout: 5000, idle_in_transaction_session_timeout: 30000, idleTimeoutMillis: 30000,
    ...(connectionString ? { connectionString } : {}) });
}
// Detect an old authority before applying the new schema.
export async function migrate(pool) {
  const { rows } = await pool.query("SELECT 1 FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relname IN ('accounts','operations') LIMIT 1");
  if (rows.length) throw new Error('此库包含旧版账本，请新建独立数据库后导入已核对的期初');
  await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
}
async function revokeColumnGrants(client, role) {
  // Table REVOKE does not remove previously granted column privileges.
  // role is an internal constant, never request input.
  const { rows } = await client.query("SELECT format('REVOKE ALL (%s) ON TABLE %I.%I FROM " + role + "',string_agg(quote_ident(a.attname),',' ORDER BY a.attnum),n.nspname,c.relname) AS sql FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped GROUP BY n.nspname,c.relname");
  for (const row of rows) await client.query(row.sql);
}
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
    await revokeColumnGrants(client, 'member_app');
    await client.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM member_app');
    await client.query('REVOKE ALL ON stores,users,sessions,app_devices,login_limits,audit_events,releases,store_settings,voice_dialogs,voice_requests,voice_device_candidates,member_profiles,member_tags,member_accounts,account_opening_batches,account_openings,ledger_entries,ledger_reversals,service_catalog,recharge_plan_items,store_recharge_settings,ledger_command_receipts,store_change_heads,store_changes FROM PUBLIC');
    await client.query('REVOKE ALL ON SEQUENCE audit_events_id_seq FROM PUBLIC');
    await client.query('GRANT SELECT ON stores,releases TO member_app');
    await client.query('GRANT INSERT ON stores TO member_app');
    await client.query('GRANT UPDATE(id) ON stores TO member_app'); // FOR UPDATE store serialization.
    await client.query('GRANT UPDATE(name,profile,profile_version) ON stores TO member_app');
    await client.query('GRANT UPDATE(status,version) ON stores TO member_app');
    await client.query('GRANT SELECT,INSERT ON users TO member_app');
    await client.query('GRANT UPDATE(id,store_id,username,display_name,password_hash,role,active,created_at,platform_disabled,version) ON users TO member_app');
    await client.query('GRANT SELECT,INSERT,UPDATE ON store_settings TO member_app');
    await client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON sessions,login_limits TO member_app');
    await client.query('GRANT SELECT,INSERT,UPDATE ON app_devices TO member_app');
    await client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON voice_dialogs TO member_app');
    await client.query('GRANT SELECT,INSERT,DELETE ON voice_requests TO member_app');
    await client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON voice_device_candidates TO member_app');
    await client.query('GRANT SELECT,INSERT ON audit_events TO member_app');
    await client.query('GRANT SELECT,INSERT,UPDATE ON member_profiles,member_accounts,service_catalog,recharge_plan_items,store_recharge_settings,store_change_heads TO member_app');
    await client.query('GRANT SELECT,INSERT,DELETE ON member_tags TO member_app');
    await client.query('GRANT SELECT,INSERT ON account_opening_batches,account_openings,ledger_entries,ledger_reversals,ledger_command_receipts,store_changes TO member_app');
    await client.query('REVOKE ALL ON consumption_items,payment_records,recharge_details FROM PUBLIC,member_app');
    await client.query('GRANT SELECT,INSERT ON consumption_items,payment_records,recharge_details TO member_app');
    await client.query('REVOKE ALL ON application_task_receipts FROM PUBLIC');
    await client.query('GRANT SELECT,INSERT ON application_task_receipts TO member_app');
    await client.query('REVOKE ALL ON application_batches,application_batch_items,application_batch_tags,application_batch_controls FROM PUBLIC,member_app');
    await client.query('GRANT SELECT,INSERT ON application_batches,application_batch_items,application_batch_tags,application_batch_controls TO member_app');
    await client.query('GRANT UPDATE(state,version) ON application_batch_controls TO member_app');
    await client.query('REVOKE ALL ON ledger_export_jobs FROM PUBLIC,member_app');
    await client.query('GRANT SELECT,INSERT,DELETE ON ledger_export_jobs TO member_app');
    await client.query('GRANT UPDATE(state,snapshot_at,row_count,artifact,failure) ON ledger_export_jobs TO member_app');
    await client.query('REVOKE ALL ON ledger_restore_receipts FROM PUBLIC,member_app');
    await client.query('REVOKE ALL ON FUNCTION refresh_recovery_statistics() FROM PUBLIC,member_app');
    await client.query('GRANT SELECT ON ledger_restore_receipts TO member_app');
    await client.query('GRANT USAGE ON SEQUENCE audit_events_id_seq TO member_app');
    await client.query('REVOKE ALL ON platform_users,platform_sessions,platform_roles,platform_permissions,platform_role_permissions,merchant_roles,merchant_permissions,merchant_role_permissions,store_licenses,offline_licenses,platform_audit_events,diagnostic_events FROM PUBLIC');
    await client.query('REVOKE ALL ON SEQUENCE platform_audit_events_id_seq,diagnostic_events_id_seq FROM PUBLIC');
    await client.query('GRANT SELECT ON platform_roles,platform_permissions,platform_role_permissions,merchant_roles,merchant_permissions,merchant_role_permissions TO member_app');
    await client.query('GRANT SELECT,INSERT,UPDATE ON platform_users,store_licenses TO member_app');
    await client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON platform_sessions TO member_app');
    await client.query('GRANT SELECT,INSERT ON offline_licenses,platform_audit_events TO member_app');
    await client.query('GRANT SELECT,INSERT,DELETE ON diagnostic_events TO member_app');
    await client.query('GRANT USAGE ON SEQUENCE platform_audit_events_id_seq,diagnostic_events_id_seq TO member_app');
  });
}
export async function assertRuntimeRole(pool) {
  const { rows: [role] } = await pool.query("SELECT r.rolname,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls, EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS memberships, has_database_privilege(current_user,current_database(),'CREATE') AS database_create, has_database_privilege(current_user,current_database(),'TEMP') AS database_temp, has_schema_privilege(current_user,'public','CREATE') AS schema_create FROM pg_roles r WHERE r.rolname=current_user");
  if (!role || role.rolname !== 'member_app' || ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls', 'memberships', 'database_create', 'database_temp', 'schema_create'].some(key => role[key])) throw new Error('生产 API 必须使用受限的 member_app 数据库账号，请先运行迁移任务');
  const { rows } = await pool.query("SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname=current_user AND c.relnamespace='public'::regnamespace LIMIT 1");
  if (rows.length) throw new Error('运行时账号不能拥有生产数据库对象');
  const { rows: [grants] } = await pool.query("SELECT has_table_privilege(current_user,'member_accounts','DELETE,TRUNCATE') OR has_table_privilege(current_user,'account_openings','UPDATE,DELETE,TRUNCATE') OR has_table_privilege(current_user,'account_opening_batches','UPDATE,DELETE,TRUNCATE') OR has_table_privilege(current_user,'ledger_entries','UPDATE,DELETE,TRUNCATE') OR has_table_privilege(current_user,'ledger_reversals','UPDATE,DELETE,TRUNCATE') OR has_table_privilege(current_user,'ledger_command_receipts','UPDATE,DELETE,TRUNCATE') OR has_table_privilege(current_user,'store_changes','UPDATE,DELETE,TRUNCATE') OR has_table_privilege(current_user,'releases','INSERT,UPDATE,DELETE,TRUNCATE') OR has_table_privilege(current_user,'audit_events','UPDATE,DELETE,TRUNCATE') OR has_table_privilege(current_user,'platform_audit_events','UPDATE,DELETE,TRUNCATE') OR has_table_privilege(current_user,'offline_licenses','UPDATE,DELETE,TRUNCATE') OR has_table_privilege(current_user,'platform_role_permissions','INSERT,UPDATE,DELETE,TRUNCATE') OR has_table_privilege(current_user,'voice_requests','UPDATE,TRUNCATE') OR has_table_privilege(current_user,'voice_dialogs','TRUNCATE') AS forbidden");
  if (grants.forbidden) throw new Error('运行时账号具有超出业务所需的数据库写入权限');
  const { rows: [saleGrants] } = await pool.query("SELECT has_table_privilege(current_user,'consumption_items','UPDATE,DELETE,TRUNCATE') OR has_table_privilege(current_user,'payment_records','UPDATE,DELETE,TRUNCATE') OR has_table_privilege(current_user,'recharge_details','UPDATE,DELETE,TRUNCATE') AS forbidden");
  if (saleGrants.forbidden) throw new Error('运行时账号不能修改或删除历史成交明细');
  const { rows: [taskGrants] } = await pool.query("SELECT has_table_privilege(current_user,'application_task_receipts','UPDATE,DELETE,TRUNCATE') AS forbidden");
  if (taskGrants.forbidden) throw new Error('运行时账号不能修改或删除任务回执');
  const { rows: batchGrants } = await pool.query("SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('application_batches','application_batch_items','application_batch_tags','application_batch_controls') AND has_table_privilege(current_user,oid,'UPDATE,DELETE,TRUNCATE') LIMIT 1");
  const { rows: [controlGrants] } = await pool.query("SELECT has_column_privilege(current_user,'application_batch_controls','store_id','UPDATE') OR has_column_privilege(current_user,'application_batch_controls','batch_id','UPDATE') AS forbidden");
  if (batchGrants.length || controlGrants.forbidden) throw new Error('运行时账号不能改删批次捕获或控制行身份');
  const { rows: [exportGrants] } = await pool.query("SELECT has_table_privilege(current_user,'ledger_export_jobs','TRUNCATE') OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='ledger_export_jobs'::regclass AND attname IN ('slot','store_id','id','ledger_epoch','actor_id','device_id','session_id','from_at','to_at','created_at','expires_at') AND has_column_privilege(current_user,attrelid,attnum,'UPDATE')) AS forbidden");
  if (exportGrants.forbidden) throw new Error('运行时账号不能整表清空或改写导出任务的身份、区间和期限');
  const { rows: [epochGrants] } = await pool.query("SELECT has_column_privilege(current_user,'stores','ledger_epoch','UPDATE') AS forbidden");
  if (epochGrants.forbidden) throw new Error('运行时账号不能更换账本代际');
  const { rows: [restoreGrants] } = await pool.query("SELECT has_table_privilege(current_user,'ledger_restore_receipts','INSERT,UPDATE,DELETE,TRUNCATE') OR has_column_privilege(current_user,'users','historical_only','UPDATE') AS forbidden");
  if (restoreGrants.forbidden) throw new Error('运行时账号不能修改恢复回执或历史身份标记');
  const { rows: [statisticsGrant] } = await pool.query("SELECT has_function_privilege(current_user,'refresh_recovery_statistics()','EXECUTE') AS forbidden");
  if (statisticsGrant.forbidden) throw new Error('运行时账号不能运行恢复统计刷新');
  const { rows: immutableColumns } = await pool.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND c.relname IN ('account_openings','account_opening_batches','ledger_entries','ledger_reversals','ledger_command_receipts','application_task_receipts','application_batches','application_batch_items','application_batch_tags','consumption_items','payment_records','recharge_details','store_changes','audit_events','ledger_restore_receipts') AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(current_user,c.oid,a.attnum,'UPDATE') LIMIT 1");
  if (immutableColumns.length) throw new Error('运行时账号具有历史记录列更新权限');
}

// Separate credentials: never grant the ordinary runtime epoch-rotation rights.
export async function configureRecoveryRole(pool, password) {
  if (typeof password !== 'string' || password.length < 32 || password.length > 256) throw new Error('RECOVERY_DATABASE_PASSWORD 必须为 32–256 位独立随机密码');
  await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(739187)');
    if (!(await client.query("SELECT 1 FROM pg_roles WHERE rolname='member_recovery'")).rows.length) await client.query('CREATE ROLE member_recovery LOGIN');
    await client.query('ALTER ROLE member_recovery LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT');
    for (const { rolname } of (await client.query("SELECT parent.rolname FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles child ON child.oid=m.member WHERE child.rolname='member_recovery'")).rows) await client.query('REVOKE "' + rolname.replaceAll('"', '""') + '" FROM member_recovery');
    const { rows: [statement] } = await client.query("SELECT format('ALTER ROLE member_recovery PASSWORD %L', $1::text) AS sql", [password]); await client.query(statement.sql);
    const { rows: [database] } = await client.query('SELECT current_database() AS name'); const name = '"' + database.name.replaceAll('"', '""') + '"';
    await client.query('REVOKE ALL ON DATABASE ' + name + ' FROM member_recovery');
    await client.query('REVOKE CREATE,TEMPORARY ON DATABASE ' + name + ' FROM PUBLIC');
    await client.query('GRANT CONNECT ON DATABASE ' + name + ' TO member_recovery');
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await client.query('REVOKE ALL ON SCHEMA public FROM member_recovery');
    await client.query('GRANT USAGE ON SCHEMA public TO member_recovery');
    await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM member_recovery');
    await revokeColumnGrants(client, 'member_recovery');
    await client.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM member_recovery');
    await client.query('GRANT SELECT ON stores,users,sessions,store_licenses,app_devices,merchant_role_permissions TO member_recovery');
    // Row-lock authorization requires UPDATE on at least one column. These
    // grants do not allow changing credentials, licences, sessions or devices.
    await client.query('GRANT UPDATE(id,ledger_epoch) ON stores TO member_recovery');
    await client.query('GRANT UPDATE(id) ON users,sessions,store_licenses TO member_recovery');
    await client.query('GRANT UPDATE(device_id) ON app_devices TO member_recovery');
    await client.query('GRANT INSERT ON users TO member_recovery');
    await client.query('GRANT SELECT,INSERT ON member_profiles,member_tags,member_accounts,account_opening_batches,account_openings,ledger_entries,ledger_reversals,service_catalog,recharge_plan_items,store_recharge_settings,consumption_items,payment_records,recharge_details,ledger_command_receipts,application_task_receipts,application_batches,application_batch_items,application_batch_tags,application_batch_controls,store_change_heads,store_changes,audit_events,ledger_restore_receipts TO member_recovery');
    await client.query('GRANT UPDATE ON store_recharge_settings TO member_recovery');
    await client.query('GRANT EXECUTE ON FUNCTION refresh_recovery_statistics() TO member_recovery');
    await client.query('GRANT USAGE ON SEQUENCE audit_events_id_seq TO member_recovery');
  });
}
export async function assertRecoveryRole(pool) {
  const { rows: [role] } = await pool.query("SELECT r.rolname,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS memberships,has_database_privilege(current_user,current_database(),'CREATE') AS database_create,has_database_privilege(current_user,current_database(),'TEMP') AS database_temp,has_schema_privilege(current_user,'public','CREATE') AS schema_create FROM pg_roles r WHERE r.rolname=current_user");
  if (!role || role.rolname !== 'member_recovery' || Object.entries(role).some(([key, value]) => key !== 'rolname' && value)) throw new Error('恢复连接必须使用受限 member_recovery 账号');
  const { rows: owners } = await pool.query("SELECT 1 FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND relnamespace='public'::regnamespace LIMIT 1");
  const { rows: [grants] } = await pool.query("SELECT has_column_privilege(current_user,'stores','ledger_epoch','UPDATE') AS rotate,has_table_privilege(current_user,'ledger_entries','UPDATE,DELETE,TRUNCATE') OR has_table_privilege(current_user,'audit_events','UPDATE,DELETE,TRUNCATE') OR has_table_privilege(current_user,'ledger_restore_receipts','UPDATE,DELETE,TRUNCATE') OR has_column_privilege(current_user,'users','password_hash','UPDATE') OR has_column_privilege(current_user,'users','active','UPDATE') OR has_column_privilege(current_user,'users','historical_only','UPDATE') OR has_table_privilege(current_user,'sessions','INSERT,DELETE,TRUNCATE') OR has_table_privilege(current_user,'store_licenses','INSERT,DELETE,TRUNCATE') AS forbidden");
  if (owners.length || !grants.rotate || grants.forbidden) throw new Error('恢复账号数据库权限不符合隔离要求');
  const { rows: [statisticsGrant] } = await pool.query("SELECT has_function_privilege(current_user,'refresh_recovery_statistics()','EXECUTE') AS allowed");
  if (!statisticsGrant.allowed) throw new Error('恢复账号缺少固定业务表统计刷新权限');
  const { rows: excessive } = await pool.query("SELECT c.relname,a.attname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(current_user,c.oid,a.attnum,'UPDATE') AND NOT (c.relname='stores' AND a.attname IN ('id','ledger_epoch') OR c.relname IN ('users','sessions','store_licenses') AND a.attname='id' OR c.relname='app_devices' AND a.attname='device_id' OR c.relname='store_recharge_settings') LIMIT 1");
  if (excessive.length) throw new Error('恢复账号具有越界列更新权限');
  const { rows: writes } = await pool.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND (has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE') OR c.relname NOT IN ('users','member_profiles','member_tags','member_accounts','account_opening_batches','account_openings','ledger_entries','ledger_reversals','service_catalog','recharge_plan_items','store_recharge_settings','consumption_items','payment_records','recharge_details','ledger_command_receipts','application_task_receipts','application_batches','application_batch_items','application_batch_tags','application_batch_controls','store_change_heads','store_changes','audit_events','ledger_restore_receipts') AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(current_user,c.oid,a.attnum,'INSERT'))) LIMIT 1");
  if (writes.length) throw new Error('恢复账号具有越界新增或删除权限');
}
export async function transaction(pool, callback, { rollbackOnly = false } = {}) {
  const client = await pool.connect();
  let discard = false, connectionError;
  // pg-pool removes its idle error listener while a client is checked out.
  // Keep a request-owned listener attached for the whole transaction so a
  // database restart cannot turn a connection loss into an uncaught
  // EventEmitter error in the API process. The failed connection is always
  // discarded below; callers still receive the query/commit error.
  const onClientError = error => { discard = true; connectionError = error; };
  client.on?.('error', onClientError);
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    if (connectionError) throw connectionError;
    try { await client.query(rollbackOnly ? 'ROLLBACK' : 'COMMIT'); }
    catch (error) { discard = true; throw error; }
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch { discard = true; }
    throw error;
  } finally {
    // A failed rollback leaves an unknown transaction state. Never hand that
    // connection to another request, or replace the original business error.
    client.off?.('error', onClientError);
    if (discard) client.release(true);
    else client.release();
  }
}
