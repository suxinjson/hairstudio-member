import { createPool } from './database.js';
import { createService } from './service.js';
const pool = createPool();
try {
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) throw new Error('须设置 ADMIN_USERNAME 和至少 12 位的 ADMIN_PASSWORD');
  const result = await createService(pool).createOwner({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD,
    displayName: process.env.ADMIN_NAME || '店主', storeName: process.env.STORE_NAME || '我的门店' });
  console.log('店主账号已创建；门店 ID：' + result.storeId);
} finally { await pool.end(); }
