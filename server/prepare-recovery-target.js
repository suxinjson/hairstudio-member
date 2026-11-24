import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createPool, transaction } from './database.js';
import { ApiError, hashPassword, normalizeUsername } from './security.js';
import { provisionStore } from './provision-store.js';
import { boundedText } from '../src/data-limits.js';

// The live API cannot choose a store identity. Only an operator on a separate,
// migrated, empty database can establish the store identity from the archive.
export async function prepareRecoveryTarget(pool, { databaseName, storeId, username, displayName, storeName, password, apply = false }) {
  if (typeof databaseName !== 'string' || !/^[a-zA-Z0-9_-]{1,63}$/.test(databaseName)) throw new ApiError(400, '须提供已核对的目标数据库名', 'RECOVERY_TARGET_DATABASE');
  if (typeof storeId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(storeId)) throw new ApiError(400, '须提供从外部归档核对的原门店 ID', 'RECOVERY_TARGET_STORE');
  username = normalizeUsername(username);
  boundedText(storeName, 128, '门店名', true); boundedText(displayName, 128, '店主显示名', true);
  const passwordHash = apply ? await hashPassword(password) : undefined;
  return transaction(pool, async client => {
    if (!apply) await client.query('SET TRANSACTION READ ONLY');
    const { rows: [connection] } = await client.query("SELECT current_database() AS db,current_schema() AS schema,current_user AS role," +
      " EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.stores') AND pg_has_role(relowner,'USAGE')) AS owns_stores," +
      " to_regclass('public.accounts') IS NOT NULL OR to_regclass('public.operations') IS NOT NULL AS old_schema");
    if (connection.db !== databaseName || connection.schema !== 'public') throw new ApiError(409, '已连接的数据库或 schema 与核对的目标不符', 'RECOVERY_TARGET_DATABASE');
    if (!connection.owns_stores || ['member_app', 'member_recovery'].includes(connection.role) || connection.old_schema) throw new ApiError(409, '须使用独立新库和完成迁移的运维身份', 'RECOVERY_TARGET_SCHEMA');
    // Prevent another operator or platform request from provisioning a store
    // after the emptiness check. No rows are modified by a plan.
    if (apply) await client.query('LOCK TABLE public.stores IN SHARE ROW EXCLUSIVE MODE');
    if ((await client.query('SELECT 1 FROM public.stores LIMIT 1')).rows.length) throw new ApiError(409, '恢复目标数据库已有门店；未修改任何业务数据', 'RECOVERY_TARGET_NOT_EMPTY');
    if (apply) await provisionStore(client, { storeId, username, displayName: displayName.trim(), storeName: storeName.trim(), passwordHash });
    return { databaseName, schema: 'public', storeId, status: apply ? 'prepared' : 'ready', licenseGranted: false };
  }, { rollbackOnly: !apply });
}

async function main() {
  const { values } = parseArgs({ options: { database: { type: 'string' }, 'store-id': { type: 'string' }, 'store-name': { type: 'string' },
    owner: { type: 'string' }, 'display-name': { type: 'string' }, apply: { type: 'boolean' } } });
  const connection = process.env.MIGRATION_DATABASE_URL;
  if (!connection) throw new ApiError(400, '须安全注入独立目标库的 MIGRATION_DATABASE_URL', 'RECOVERY_TARGET_DATABASE');
  const pool = createPool(connection);
  try {
    const result = await prepareRecoveryTarget(pool, { databaseName: values.database, storeId: values['store-id'], storeName: values['store-name'],
      username: values.owner, displayName: values['display-name'], password: process.env.MEMBER_RECOVERY_OWNER_PASSWORD, apply: values.apply === true });
    process.stdout.write(JSON.stringify(result) + String.fromCharCode(10));
  } finally { await pool.end(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await main(); }
  catch (error) {
    // Driver messages sometimes echo inputs. Limit diagnostics to known local
    // validation messages or a SQLSTATE, never echo the connection string.
    const sqlstate = /^[0-9A-Z]{5}$/.test(error.code ?? '') ? ' (' + error.code + ')' : '';
    console.error(error instanceof ApiError ? error.message : '准备恢复目标失败，请检查参数、数据库可达性和迁移权限' + sqlstate);
    process.exitCode = 1;
  }
}
