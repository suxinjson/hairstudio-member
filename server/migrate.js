import { createPool, migrate, configureRuntimeRole, configureRecoveryRole } from './database.js';
const pool = createPool();
try {
  await migrate(pool);
  await configureRuntimeRole(pool, process.env.APP_DATABASE_PASSWORD);
  if (process.env.RECOVERY_DATABASE_PASSWORD) {
    if (process.env.RECOVERY_DATABASE_PASSWORD === process.env.APP_DATABASE_PASSWORD) throw new Error('恢复账号必须使用独立密码');
    await configureRecoveryRole(pool, process.env.RECOVERY_DATABASE_PASSWORD);
  }
  console.log('数据库结构与 member_app 运行权限已更新');
} finally { await pool.end(); }
