import { createPool } from './database.js';
import { createPlatformService } from './platform.js';
const pool = createPool();
try {
  if (!process.env.PLATFORM_ADMIN_USERNAME || !process.env.PLATFORM_ADMIN_PASSWORD) throw new Error('请设置 PLATFORM_ADMIN_USERNAME 和至少 12 位的 PLATFORM_ADMIN_PASSWORD');
  const result = await createPlatformService(pool).bootstrap({ username: process.env.PLATFORM_ADMIN_USERNAME, password: process.env.PLATFORM_ADMIN_PASSWORD, displayName: process.env.PLATFORM_ADMIN_NAME || '平台管理员' });
  console.log('平台首位管理员已创建：' + result.id + '；请访问 /admin/platform.html');
} finally { await pool.end(); }
