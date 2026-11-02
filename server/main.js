import { createPool, migrate } from './database.js';
import { createService } from './service.js';
import { createApi } from './http.js';
const pool = createPool();
await migrate(pool);
const server = createApi({ service: createService(pool), pool,
  production: process.env.NODE_ENV === 'production',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'https://localhost').split(',').map(value => value.trim()),
  releaseDirectory: process.env.RELEASE_DIRECTORY || './releases' });
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log('云端 API 已启动'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await pool.end(); process.exit(0); }));
