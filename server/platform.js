import { randomUUID } from 'node:crypto';
import { transaction } from './database.js';
import { ApiError, digest, hashPassword, normalizeUsername, token, verifyPassword } from './security.js';
import { boundedText } from '../src/data-limits.js';
import { normalizeFeatures } from './entitlements.js';
import { configuredLicenseSigner, licenseEnd } from './license-signer.js';
import { provisionStore } from './provision-store.js';
import { OFFLINE_LICENSE_FEATURES } from '../src/license-policy.js';

const roles = ['superadmin', 'operator', 'developer', 'auditor'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function id(value) { if (!uuid.test(value || '')) throw new ApiError(400, '标识无效'); return value; }
function version(value, absent = false) { if (!Number.isInteger(value) || value < (absent ? -1 : 0)) throw new ApiError(400, '缺少有效的版本号'); return value; }
function page(input = {}) {
  const limit = input.limit === undefined ? 50 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, '分页大小须为 1–100');
  return { limit, before: input.before || null };
}
const publicOperator = row => ({ id: row.id, username: row.username, displayName: row.display_name, role: row.role_id, active: row.active, version: row.version });

export function createPlatformService(pool, { signer = configuredLicenseSigner(), diagnostics = null } = {}) {
  async function audit(client, actor, event, storeId = null, details = {}) {
    await client.query('INSERT INTO platform_audit_events(actor_id,store_id,event,details) VALUES($1,$2,$3,$4)', [actor?.id || null, storeId, event, details]);
  }
  async function authenticated(client, identity, permission) {
    const { rows: [user] } = await client.query('SELECT u.* FROM platform_users u JOIN platform_sessions s ON s.user_id=u.id WHERE s.id=$1 AND s.expires_at>now() FOR SHARE OF u,s', [identity?.sessionId || null]);
    if (!user?.active || user.id !== identity.id) throw new ApiError(401, '平台登录已失效', 'PLATFORM_AUTH_REQUIRED');
    const permissions = (await client.query('SELECT permission_id FROM platform_role_permissions WHERE role_id=$1', [user.role_id])).rows.map(row => row.permission_id);
    if (permission && !permissions.includes(permission)) throw new ApiError(403, '平台账号没有此操作权限', 'PLATFORM_FORBIDDEN');
    return { ...user, permissions };
  }
  const run = (identity, permission, callback) => transaction(pool, async client => callback(client, await authenticated(client, identity, permission)));
  // Acquire before authentication's shared row locks, consistently with team
  // changes, so simultaneous session revocations cannot deadlock on upgrades.
  const changeIdentity = (identity, callback) => transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(739187)');
    return callback(client, await authenticated(client, identity, null));
  });
  async function store(client, storeId) {
    const row = (await client.query('SELECT * FROM stores WHERE id=$1 FOR UPDATE', [id(storeId)])).rows[0];
    if (!row) throw new ApiError(404, '门店不存在'); return row;
  }
  return {
    async bootstrap({ username, password, displayName = '平台管理员' }) {
      username = normalizeUsername(username); boundedText(displayName, 128, '显示名', true);
      const passwordHash = await hashPassword(password);
      return transaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(739187)');
        if ((await client.query('SELECT 1 FROM platform_users LIMIT 1')).rows.length) throw new ApiError(409, '平台管理员已存在，请通过平台后台管理账号');
        const userId = randomUUID();
        await client.query("INSERT INTO platform_users(id,username,display_name,password_hash,role_id) VALUES($1,$2,$3,$4,'superadmin')", [userId, username, displayName.trim(), passwordHash]);
        await audit(client, { id: userId }, 'platform_bootstrapped');
        return { id: userId };
      });
    },
    async login(input, ip) {
      let username; try { username = normalizeUsername(input.username); } catch { throw new ApiError(401, '账号或密码错误', 'PLATFORM_AUTH_REQUIRED'); }
      for (const value of ['platform:user:' + username, 'platform:ip:' + ip]) {
        const row = (await pool.query("INSERT INTO login_limits(bucket,failures) VALUES($1,1) ON CONFLICT(bucket) DO UPDATE SET failures=CASE WHEN login_limits.window_start<=now()-interval '15 minutes' THEN 1 ELSE login_limits.failures+1 END, window_start=CASE WHEN login_limits.window_start<=now()-interval '15 minutes' THEN now() ELSE login_limits.window_start END RETURNING failures", [digest(value)])).rows[0];
        if (row.failures > (value.startsWith('platform:user:') ? 20 : 80)) throw new ApiError(429, '平台登录尝试过多，请 15 分钟后重试', 'RATE_LIMITED');
      }
      const user = (await pool.query('SELECT * FROM platform_users WHERE username=$1', [username])).rows[0];
      if (!await verifyPassword(input.password, user?.password_hash) || !user?.active) {
        await audit(pool, null, 'platform_login_failed', null, { subjectHash: digest(username) });
        throw new ApiError(401, '账号或密码错误', 'PLATFORM_AUTH_REQUIRED');
      }
      return transaction(pool, async client => {
        const current = (await client.query('SELECT * FROM platform_users WHERE id=$1 FOR UPDATE', [user.id])).rows[0];
        if (!current.active || current.password_hash !== user.password_hash) throw new ApiError(401, '账号或密码错误', 'PLATFORM_AUTH_REQUIRED');
        const accessToken = token(), sessionId = randomUUID(), expiresAt = new Date(Date.now() + 8 * 3600000).toISOString();
        await client.query('DELETE FROM platform_sessions WHERE user_id=$1 AND expires_at<=now()', [user.id]);
        const sessions = (await client.query('SELECT id FROM platform_sessions WHERE user_id=$1 ORDER BY created_at DESC', [user.id])).rows;
        for (const old of sessions.slice(7)) await client.query('DELETE FROM platform_sessions WHERE id=$1', [old.id]);
        await client.query('INSERT INTO platform_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4)', [sessionId, user.id, digest(accessToken), expiresAt]);
        await audit(client, user, 'platform_login');
        const actor = await authenticated(client, { id: user.id, sessionId });
        return { accessToken, expiresAt, user: { ...publicOperator(current), permissions: actor.permissions } };
      });
    },
    async authenticate(accessToken) {
      if (typeof accessToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(accessToken)) throw new ApiError(401, '请登录平台后台', 'PLATFORM_AUTH_REQUIRED');
      const row = (await pool.query('SELECT u.id,s.id AS session_id FROM platform_sessions s JOIN platform_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true', [digest(accessToken)])).rows[0];
      if (!row) throw new ApiError(401, '平台登录已失效', 'PLATFORM_AUTH_REQUIRED');
      return { id: row.id, sessionId: row.session_id };
    },
    me(identity) { return run(identity, null, async (_client, actor) => ({ ...publicOperator(actor), permissions: actor.permissions })); },
    logout(identity) { return changeIdentity(identity, async (client, actor) => { await client.query('DELETE FROM platform_sessions WHERE id=$1', [identity.sessionId]); await audit(client, actor, 'platform_logout'); return { success: true }; }); },
    async changePassword(identity, input) {
      const current = await run(identity, null, async (_client, actor) => actor);
      if (!await verifyPassword(input.currentPassword, current.password_hash)) throw new ApiError(403, '原密码不正确');
      const passwordHash = await hashPassword(input.password);
      return changeIdentity(identity, async (client, actor) => {
        if (actor.password_hash !== current.password_hash) throw new ApiError(409, '密码已变更，请重新登录');
        await client.query('UPDATE platform_users SET password_hash=$1,version=version+1 WHERE id=$2', [passwordHash, actor.id]);
        await client.query('DELETE FROM platform_sessions WHERE user_id=$1', [actor.id]);
        await audit(client, actor, 'platform_password_changed'); return { success: true };
      });
    },
    stores(identity, input = {}) { return run(identity, 'stores.read', async client => {
      const { limit, before } = page(input); if (before) id(before);
      boundedText(input.search || '', 64, '查询词');
      const search = (input.search || '').toLowerCase().replace(/[\%_]/g, '\$&') + '%';
      return (await client.query('SELECT s.id,s.name,s.status,s.version,s.created_at,l.active AS license_active,l.expires_at,l.features,l.offline_hours,l.version AS license_version FROM stores s LEFT JOIN store_licenses l ON l.store_id=s.id WHERE ($1::uuid IS NULL OR s.id<$1::uuid) AND lower(s.name) LIKE $2 ORDER BY s.id DESC LIMIT $3', [before, search, limit])).rows;
    }); },
    async createStore(identity, input) {
      await run(identity, 'stores.write', async () => {});
      const username = normalizeUsername(input.username); boundedText(input.storeName, 128, '门店名', true); boundedText(input.displayName, 128, '店主姓名', true);
      const passwordHash = await hashPassword(input.password);
      return run(identity, 'stores.write', async (client, actor) => {
        const created = await provisionStore(client, { username, passwordHash, displayName: input.displayName.trim(), storeName: input.storeName.trim() });
        await audit(client, actor, 'store_created', created.storeId, { ownerId: created.userId }); return created;
      });
    },
    updateStore(identity, storeId, input) { return run(identity, 'stores.write', async (client, actor) => {
      const current = await store(client, storeId); version(input.expectedVersion);
      if (!['active', 'suspended'].includes(input.status)) throw new ApiError(400, '门店状态无效');
      if (current.version !== input.expectedVersion) throw new ApiError(409, '门店已被修改，请刷新', 'VERSION_CONFLICT');
      await client.query('UPDATE stores SET status=$1,version=version+1 WHERE id=$2', [input.status, storeId]);
      await audit(client, actor, 'store_status_changed', storeId, { status: input.status }); return { success: true, version: current.version + 1 };
    }); },
    users(identity, storeId) { return run(identity, 'users.read', async client => {
      id(storeId);
      return (await client.query('SELECT id,store_id,username,display_name,role,active,platform_disabled,version FROM users WHERE store_id=$1 AND historical_only=false ORDER BY created_at,id LIMIT 100', [storeId])).rows;
    }); },
    async updateUser(identity, userId, input) {
      id(userId); id(input.storeId);
      if (typeof input.disabled !== 'boolean' || !['owner', 'clerk', 'viewer'].includes(input.role)) throw new ApiError(400, '用户权限无效');
      await run(identity, 'users.write', async () => {});
      const passwordHash = input.password === undefined ? null : await hashPassword(input.password);
      return run(identity, 'users.write', async (client, actor) => {
        await store(client, input.storeId);
        const rows = (await client.query('SELECT * FROM users WHERE store_id=$1 FOR UPDATE', [input.storeId])).rows;
        const target = rows.find(row => row.id === userId); if (!target) throw new ApiError(404, '用户不属于此门店');
        if (target.historical_only) throw new ApiError(409, '历史操作人引用不能启用或修改', 'HISTORICAL_ACTOR');
        if (target.version !== version(input.expectedVersion)) throw new ApiError(409, '用户权限已被修改，请刷新', 'VERSION_CONFLICT');
        if (!input.disabled && input.role !== 'owner' && target.role === 'owner' && rows.filter(row => row.role === 'owner' && row.active && !row.platform_disabled).length <= 1) throw new ApiError(409, '请先指定另一位在用店主');
        await client.query('UPDATE users SET platform_disabled=$1,role=$2,password_hash=COALESCE($3,password_hash),version=version+1 WHERE id=$4 AND store_id=$5', [input.disabled, input.role, passwordHash, userId, input.storeId]);
        await client.query('UPDATE sessions SET revoked=true WHERE user_id=$1', [userId]);
        await audit(client, actor, 'merchant_user_changed', input.storeId, { userId, disabled: input.disabled, role: input.role, passwordReset: Boolean(passwordHash) }); return { success: true };
      });
    },
    license(identity, storeId) { return run(identity, 'licenses.read', async client => ({
      online: (await client.query('SELECT * FROM store_licenses WHERE store_id=$1', [id(storeId)])).rows[0] || null,
      offline: (await client.query('SELECT id,device_id,key_id,payload,issued_at FROM offline_licenses WHERE store_id=$1 ORDER BY issued_at DESC,id DESC LIMIT 100', [storeId])).rows
    })); },
    setLicense(identity, storeId, input) { return run(identity, 'licenses.write', async (client, actor) => {
      await store(client, storeId); version(input.expectedVersion, true);
      if (typeof input.active !== 'boolean' || !Number.isInteger(input.offlineHours) || input.offlineHours < 0 || input.offlineHours > 8760) throw new ApiError(400, '在线授权策略无效');
      const current = (await client.query('SELECT * FROM store_licenses WHERE store_id=$1 FOR UPDATE', [storeId])).rows[0];
      if ((current?.version ?? -1) !== input.expectedVersion) throw new ApiError(409, '授权已被修改，请刷新后重试', 'VERSION_CONFLICT');
      const action = input.action || 'renew';
      if (!['renew', 'policy'].includes(action) || action === 'policy' && !current) throw new ApiError(400, '请选择有效的授权操作');
      const startsAt = action === 'policy' ? current.starts_at : new Date();
      const expiresAt = action === 'policy' ? current.expires_at : licenseEnd(input, startsAt), features = normalizeFeatures(input.features);
      const licenseId = current?.id || randomUUID();
      await client.query('INSERT INTO store_licenses(id,store_id,active,starts_at,expires_at,features,offline_hours) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(store_id) DO UPDATE SET active=EXCLUDED.active,starts_at=EXCLUDED.starts_at,expires_at=EXCLUDED.expires_at,features=EXCLUDED.features,offline_hours=EXCLUDED.offline_hours,version=store_licenses.version+1,updated_at=now()', [licenseId, storeId, input.active, startsAt, expiresAt, JSON.stringify(features), input.offlineHours]);
      await audit(client, actor, 'online_license_changed', storeId, { licenseId, active: input.active, expiresAt, features, offlineHours: input.offlineHours });
      return { id: licenseId, expiresAt, version: (current?.version ?? -1) + 1 };
    }); },
    issueOfflineLicense(identity, storeId, input) { return run(identity, 'licenses.write', async (client, actor) => {
      const current = await store(client, storeId);
      if (current.status !== 'active') throw new ApiError(409, '停用门店不能签发授权');
      if (!signer) throw new ApiError(503, '平台尚未配置离线授权签名密钥', 'SIGNER_UNAVAILABLE');
      if (typeof input.deviceId !== 'string' || !/^[A-Za-z0-9-]{16,80}$/.test(input.deviceId)) throw new ApiError(400, '请从 App 复制完整设备标识');
      const username = normalizeUsername(input.username); boundedText(input.displayName, 128, '本地账号姓名', true);
      const features = normalizeFeatures(input.features);
      if (features.some(feature => !OFFLINE_LICENSE_FEATURES.includes(feature))) throw new ApiError(400, '独立离线授权不支持云端语音、员工或设备管理');
      const issuedAt = new Date(), expiresAt = licenseEnd(input, issuedAt), licenseId = randomUUID();
      const payload = { v: 1, mode: 'offline', id: licenseId, storeId, storeName: current.name, deviceId: input.deviceId,
        issuedAt: issuedAt.toISOString(), notBefore: issuedAt.toISOString(), expiresAt, features,
        user: { id: randomUUID(), username, displayName: input.displayName.trim(), role: 'owner' } };
      const code = signer.sign(payload);
      await client.query('INSERT INTO offline_licenses(id,store_id,device_id,key_id,payload,code_hash,issued_by) VALUES($1,$2,$3,$4,$5,$6,$7)', [licenseId, storeId, input.deviceId, signer.keyId, payload, digest(code), actor.id]);
      await audit(client, actor, 'offline_license_issued', storeId, { licenseId, deviceId: input.deviceId, expiresAt, features: payload.features, keyId: signer.keyId });
      return { code, payload };
    }); },
    operators(identity) { return run(identity, 'operators.read', async client => (await client.query('SELECT id,username,display_name,role_id,active,version FROM platform_users ORDER BY username LIMIT 100')).rows.map(publicOperator)); },
    async saveOperator(identity, userId, input) {
      if (userId) id(userId);
      if (!roles.includes(input.role) || typeof input.active !== 'boolean') throw new ApiError(400, '平台角色无效');
      boundedText(input.displayName, 128, '姓名', true);
      await run(identity, 'operators.write', async () => {});
      const username = userId ? null : normalizeUsername(input.username), passwordHash = input.password === undefined && userId ? null : await hashPassword(input.password);
      return transaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(739187)');
        const actor = await authenticated(client, identity, 'operators.write');
        const rows = (await client.query('SELECT * FROM platform_users FOR UPDATE')).rows;
        if (rows.length >= 100 && !userId) throw new ApiError(413, '平台账号数量已达上限');
        const current = rows.find(row => row.id === userId);
        if (userId && !current) throw new ApiError(404, '平台账号不存在');
        if (current && current.version !== version(input.expectedVersion)) throw new ApiError(409, '平台账号已被修改', 'VERSION_CONFLICT');
        if (current?.active && current.role_id === 'superadmin' && (!input.active || input.role !== 'superadmin') && rows.filter(row => row.active && row.role_id === 'superadmin').length <= 1) throw new ApiError(409, '必须保留至少一位在用平台超级管理员');
        const targetId = userId || randomUUID();
        if (current) {
          await client.query('UPDATE platform_users SET display_name=$1,role_id=$2,active=$3,password_hash=COALESCE($4,password_hash),version=version+1 WHERE id=$5', [input.displayName.trim(), input.role, input.active, passwordHash, targetId]);
          await client.query('DELETE FROM platform_sessions WHERE user_id=$1', [targetId]);
        } else await client.query('INSERT INTO platform_users(id,username,display_name,password_hash,role_id,active) VALUES($1,$2,$3,$4,$5,$6)', [targetId, username, input.displayName.trim(), passwordHash, input.role, input.active]);
        await audit(client, actor, 'platform_operator_changed', null, { userId: targetId, role: input.role, active: input.active, passwordReset: Boolean(passwordHash) }); return { id: targetId };
      });
    },
    logs(identity, input = {}) { return run(identity, 'logs.read', async client => {
      const { before, limit } = page(input);
      if (before && (!/^[1-9]\d{0,18}$/.test(before) || BigInt(before) > 9223372036854775807n)) throw new ApiError(400, '日志游标无效');
      const storeId = input.storeId ? id(input.storeId) : null;
      if (!['platform', 'merchant', 'diagnostic'].includes(input.kind || 'platform')) throw new ApiError(400, '日志类型无效');
      if (input.kind === 'diagnostic') return (await client.query('SELECT * FROM diagnostic_events WHERE ($1::bigint IS NULL OR id<$1) ORDER BY id DESC LIMIT $2', [before, limit])).rows;
      if (input.kind === 'merchant') return (await client.query('SELECT a.id,a.store_id,a.user_id,a.event,a.details,a.received_at,u.display_name FROM audit_events a LEFT JOIN users u ON u.id=a.user_id WHERE ($1::bigint IS NULL OR a.id<$1) AND ($2::uuid IS NULL OR a.store_id=$2) ORDER BY a.id DESC LIMIT $3', [before, storeId, limit])).rows;
      return (await client.query('SELECT a.*,u.display_name FROM platform_audit_events a LEFT JOIN platform_users u ON u.id=a.actor_id WHERE ($1::bigint IS NULL OR a.id<$1) AND ($2::uuid IS NULL OR a.store_id=$2) ORDER BY a.id DESC LIMIT $3', [before, storeId, limit])).rows;
    }); },
    system(identity) { return run(identity, 'system.read', async () => ({
      status: 'ready', signer: signer ? { keyId: signer.keyId, publicKey: signer.publicKey } : null,
      diagnostics: diagnostics?.snapshot() || null,
      storage: 'PostgreSQL; per-store transactional JSONB ledger snapshot',
      topology: 'Deployment dependent; the default compose is a single database and API.'
    })); }
  };
}
