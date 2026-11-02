import { createPool, migrate, configureRuntimeRole } from './database.js';
const pool = createPool();
try {
  await migrate(pool);
  await configureRuntimeRole(pool, process.env.APP_DATABASE_PASSWORD);
  console.log('数据库结构与 member_app 运行权限已更新');
} finally { await pool.end(); }
