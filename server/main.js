import { createPool, assertRuntimeRole, assertRecoveryRole } from './database.js';
import { createService } from './service.js';
import { createApi, defaultAllowedOrigins } from './http.js';
import { writeAliGenieLog } from './aligenie-log.js';
import { createDiagnostics } from './diagnostics.js';
import { createLedgerExportWorker } from './relational-export-worker.js';
const pool = createPool();
const recoveryPool = process.env.RECOVERY_DATABASE_URL ? createPool(process.env.RECOVERY_DATABASE_URL) : null;
if (recoveryPool) {
  recoveryPool.on('error', error => console.error('恢复数据库空闲连接错误:', error.code || 'DATABASE_ERROR'));
  if (process.env.NODE_ENV === 'production') await assertRecoveryRole(recoveryPool);
}
pool.on('error', error => console.error('数据库空闲连接错误:', error.code || 'DATABASE_ERROR'));
const diagnostics = createDiagnostics(pool);
if (process.env.NODE_ENV === 'production') await assertRuntimeRole(pool);
const service = createService(pool, { recoveryPool });
const exportPool = createPool(undefined, { max: 1 });
exportPool.on('error', error => console.error('导出数据库空闲连接错误:', error.code || 'DATABASE_ERROR'));
const exportWorker = createLedgerExportWorker({ pool: exportPool, jobs: service.relational, onError: code => console.error('导出后台任务失败:', code) });
const server = createApi({ service, pool,
  diagnostics,
  aligenieLogger: process.env.ALIGENIE_LOG_ENABLED === 'false' ? null : writeAliGenieLog,
  production: process.env.NODE_ENV === 'production',
  trustedProxyIPs: (process.env.TRUSTED_PROXY_IPS || '').split(',').map(value => value.trim()).filter(Boolean),
  allowedOrigins: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean) : defaultAllowedOrigins(process.env.NODE_ENV === 'production'),
  releaseDirectory: process.env.RELEASE_DIRECTORY || './releases' });
server.listen(Number(process.env.PORT || 48927), process.env.HOST || '127.0.0.1', () => console.log(`云端 API 已启动，监听端口: ${process.env.PORT || 48927}`));
exportWorker.start();
const cleanup = setInterval(async () => {
  try {
    await pool.query("DELETE FROM login_limits WHERE window_start<now()-interval '1 day'");
    await pool.query('DELETE FROM platform_sessions WHERE expires_at<now()');
    // Bound maintenance work; audit retention is an explicit offline DBA task.
    await pool.query("DELETE FROM diagnostic_events WHERE id IN (SELECT id FROM diagnostic_events WHERE received_at<now()-interval '7 days' ORDER BY received_at LIMIT 1000)");
  } catch (error) { console.error('清理诊断数据失败:', error.code || 'DATABASE_ERROR'); }
}, 15 * 60000);
cleanup.unref();
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return; stopping = true; clearInterval(cleanup);
  const deadline = setTimeout(() => process.exit(1), 20000); deadline.unref();
  const exportClosed = exportWorker.close();
  server.close(async () => {
    await Promise.all([diagnostics.close(), exportClosed]);
    await Promise.all([pool.end(), recoveryPool?.end(), exportPool.end()]); clearTimeout(deadline); process.exit(0);
  });
});
