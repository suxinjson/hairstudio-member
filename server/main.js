import { createPool, assertRuntimeRole } from './database.js';
import { createService } from './service.js';
import { createApi } from './http.js';
const pool = createPool();
if (process.env.NODE_ENV === 'production') await assertRuntimeRole(pool);
const server = createApi({ service: createService(pool), pool,
  production: process.env.NODE_ENV === 'production',
  trustedProxyIPs: (process.env.TRUSTED_PROXY_IPS || '').split(',').map(value => value.trim()).filter(Boolean),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'https://localhost').split(',').map(value => value.trim()),
  releaseDirectory: process.env.RELEASE_DIRECTORY || './releases' });
server.listen(Number(process.env.PORT || 48927), process.env.HOST || '127.0.0.1', () => console.log(`云端 API 已启动，监听端口: ${process.env.PORT || 48927}`));
const cleanup = setInterval(() => pool.query("DELETE FROM login_limits WHERE window_start<now()-interval '1 day'").catch(error => console.error('清理登录计数失败:', error.code || 'DATABASE_ERROR')), 15 * 60000);
cleanup.unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await pool.end(); process.exit(0); }));
