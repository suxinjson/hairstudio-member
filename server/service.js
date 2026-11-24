import { randomUUID } from 'node:crypto';
import { transaction } from './database.js';
import { token, digest, hashPassword, verifyPassword, normalizeUsername, ApiError, publicUser } from './security.js';
import { assertJsonBudget, boundedText } from '../src/data-limits.js';
import { sanitizeVoiceConfig, readVoiceConfig, publicVoiceConfig, synthesizeTTS } from './voice.js';
import { handleAliGenieWebhook, getAliGenieVerificationContent, aliGenieDeviceScope } from './aligenie.js';
import { ensureDevice, checkDevice, deviceGrant } from './device-access.js';
import { readStoreProfile } from './store-profile.js';
import { normalizeStoreProfile } from '../src/store-profile.js';
import { storeEntitlement, requireFeature, commercialGrant } from './entitlements.js';
import { provisionStore } from './provision-store.js';
import { createRelationalLedger } from './relational-ledger.js';
import { createLedgerExportJobs } from './relational-export-jobs.js';

const sessionTimes = () => [new Date(Date.now() + 15 * 60000), new Date(Date.now() + 30 * 86400000)];
let activeSynthesis = 0;
const MAX_SYNTHESIS = 4;

export function createService(pool, { fetchFn, socketFn, recoveryPool } = {}) {
  async function audit(client, user, event, details = {}, occurredAt = null) {
    await client.query('INSERT INTO audit_events(store_id,user_id,device_id,event,details,occurred_at) VALUES($1,$2,$3,$4,$5,$6)',
      [user.store_id, user.id, user.device_id || null, event, details, occurredAt]);
  }
  async function lockedUser(client, identity) {
    const entitlement = await storeEntitlement(client, identity.store_id);
    const { rows: [user] } = await client.query('SELECT u.*,s.device_id,s.expires_at AS session_expires_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.id=$1 AND s.revoked=false AND s.expires_at>now() FOR SHARE OF u,s', [identity.sessionId]);
    if (!user?.active || user.historical_only || user.id !== identity.id) throw new ApiError(401, '登录已失效，请重新登录', 'AUTH_REQUIRED');
    if (user.platform_disabled) throw new ApiError(403, '账号已被平台禁用', 'USER_DISABLED');
    user.entitlements = entitlement;
    user.permissions = (await client.query('SELECT permission_id FROM merchant_role_permissions WHERE role_id=$1', [user.role])).rows.map(row => row.permission_id);
    if (!user.permissions.includes('account.read')) throw new ApiError(403, '账号没有账本访问权限', 'FORBIDDEN');
    await checkDevice(client, user.store_id, user.device_id);
    return user;
  }
  async function authorize(identity, permission) {
    return transaction(pool, async client => {
      const user = await lockedUser(client, identity);
      if (permission === 'owner' && !user.permissions.includes('store.manage') || permission === 'write' && !user.permissions.includes('account.write')) throw new ApiError(403, '当前账号没有此操作权限', 'FORBIDDEN');
      return user;
    });
  }
  // Authorization locks are held until the financial transaction commits.
  // Imports acquire the store lock first; normal writers share it, so an
  // opening import cannot race the first member or financial command.
  async function withAuthorized(identity, permission, callback, { exclusiveStore = false, consistentRead = false, recovery = false, rollbackOnly = false } = {}) {
    if (recovery && !recoveryPool) throw new ApiError(503, '独立恢复数据库账号未配置', 'RECOVERY_UNAVAILABLE');
    return transaction(recovery ? recoveryPool : pool, async client => {
      if (consistentRead) await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      if (exclusiveStore) await client.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE', [identity.store_id]);
      const user = await lockedUser(client, identity);
      if (user.store_id !== identity.store_id || permission === 'owner' && !user.permissions.includes('store.manage') ||
          permission === 'write' && !user.permissions.includes('account.write')) throw new ApiError(403, '当前账号没有此操作权限', 'FORBIDDEN');
      const { rows: [book] } = await client.query('SELECT ledger_epoch FROM stores WHERE id=$1', [user.store_id]);
      user.ledger_epoch = book.ledger_epoch;
      const result = await callback(client, user);
      if (Date.parse(user.session_expires_at) <= Date.now()) throw new ApiError(401, '登录已失效，请重新登录', 'AUTH_REQUIRED');
      if (user.entitlements.expiresAt && Date.parse(user.entitlements.expiresAt) <= Date.now()) throw new ApiError(403, '门店授权已到期', 'LICENSE_EXPIRED');
      await checkDevice(client, user.store_id, user.device_id);
      return result;
    }, { rollbackOnly });
  }
  async function reserveLogin(username, ip) {
    const failureBuckets = [digest('user:' + username), digest('ip:' + ip)];
    const quotas = [...failureBuckets.map(bucket => [bucket, 10]), [digest('attempt-user:' + username), 60], [digest('attempt-ip:' + ip), 120]].sort(([a], [b]) => a.localeCompare(b));
    return transaction(pool, async client => {
      const reserved = [];
      for (const [bucket, maximum] of quotas) {
        const { rows: [row] } = await client.query("INSERT INTO login_limits(bucket,failures) VALUES($1,1) ON CONFLICT(bucket) DO UPDATE SET failures=CASE WHEN login_limits.window_start<=now()-interval '15 minutes' THEN 1 ELSE login_limits.failures+1 END, window_start=CASE WHEN login_limits.window_start<=now()-interval '15 minutes' THEN now() ELSE login_limits.window_start END RETURNING failures,window_start::text AS window_start", [bucket]);
        if (row.failures > maximum) throw new ApiError(429, '尝试次数过多，请 15 分钟后再试', 'RATE_LIMITED');
        if (failureBuckets.includes(bucket)) reserved.push({ bucket, start: row.window_start });
      }
      return reserved;
    });
  }
  async function releaseLogin(reserved) {
    // Compare the window so a late success cannot refund a newer window's quota.
    for (const { bucket, start } of reserved) await pool.query('UPDATE login_limits SET failures=GREATEST(0,failures-1) WHERE bucket=$1 AND window_start=$2', [bucket, start]);
  }
  const relational = { ...createRelationalLedger({ withAuthorized, audit }), ...createLedgerExportJobs({ pool, withAuthorized, audit }) };
  return {
    authorize,
    relational,
    async createOwner({ username, password, displayName = '店主', storeName = '我的门店' }) {
      username = normalizeUsername(username);
      boundedText(displayName, 128, '显示名', true); boundedText(storeName, 128, '门店名', true);
      const passwordHash = await hashPassword(password);
      return transaction(pool, async client => {
        return provisionStore(client, { username, passwordHash, displayName, storeName });
      });
    },
    async login({ username, password, deviceId, clientKind = 'web', deviceFingerprint = null, deviceName = '' }, ip) {
      if (!['native', 'web'].includes(clientKind)) throw new ApiError(400, '客户端类型无效');
      if (typeof deviceId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(deviceId) || /^voice-[0-9a-f]{64}$/.test(deviceId)) throw new ApiError(400, '设备标识无效');
      try { username = normalizeUsername(username); } catch { throw new ApiError(401, '账号或密码错误'); }
      const reserved = await reserveLogin(username, ip);
      const { rows: [user] } = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
      let valid;
      try { valid = await verifyPassword(password, user?.password_hash); }
      catch (error) { await releaseLogin(reserved); throw error; }
      if (!valid || !user?.active || user.historical_only) {
        throw new ApiError(401, '账号或密码错误', 'AUTH_REQUIRED');
      }
      const accessToken = token(), refreshToken = token(), sessionId = randomUUID();
      const [accessExpires, expires] = sessionTimes();
      let authorization, storeProfile, entitlements;
      const currentUser = await transaction(pool, async client => {
        entitlements = await storeEntitlement(client, user.store_id);
        const { rows: [current] } = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [user.id]);
        if (!current?.active || current.historical_only || current.password_hash !== user.password_hash) throw new ApiError(401, '账号或密码错误');
        if (current.platform_disabled) throw new ApiError(403, '账号已被平台禁用', 'USER_DISABLED');
        await client.query("DELETE FROM sessions WHERE user_id=$1 AND expires_at<now()", [user.id]);
        authorization = commercialGrant(deviceGrant(await ensureDevice(client, current, deviceId, clientKind, deviceFingerprint, deviceName)), entitlements, current);
        storeProfile = await readStoreProfile(client, current.store_id);
        await client.query('INSERT INTO sessions(id,user_id,device_id,access_hash,refresh_hash,access_expires_at,expires_at,client_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [sessionId, user.id, deviceId, digest(accessToken), digest(refreshToken), accessExpires, clientKind === 'native' ? 'infinity' : expires, clientKind]);
        await audit(client, { ...current, device_id: deviceId }, 'login');
        return current;
      });
      await releaseLogin(reserved);
      return { accessToken, refreshToken, user: publicUser(currentUser), expiresAt: accessExpires.toISOString(), authorization, entitlements, storeProfile };
    },
    async authenticate(accessToken) {
      if (typeof accessToken !== 'string' || accessToken.length > 128) throw new ApiError(401, '请登录', 'AUTH_REQUIRED');
      const { rows: [row] } = await pool.query('SELECT u.*,s.id AS session_id,s.device_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE ((s.access_hash=$1 AND s.access_expires_at>now()) OR (s.previous_access_hash=$1 AND s.previous_access_expires_at>now())) AND s.revoked=false AND s.expires_at>now() AND u.active=true', [digest(accessToken)]);
      if (!row || row.historical_only) throw new ApiError(401, '登录已失效，请重新登录', 'AUTH_REQUIRED');
      if (row.platform_disabled) throw new ApiError(403, '账号已被平台禁用', 'USER_DISABLED');
      await transaction(pool, async client => { await storeEntitlement(client, row.store_id); await checkDevice(client, row.store_id, row.device_id); });
      return { ...row, sessionId: row.session_id };
    },
    async refresh(refreshToken, clientKind, deviceFingerprint = null, deviceName = '') {
      if (typeof refreshToken !== 'string' || refreshToken.length > 128) throw new ApiError(401, '请重新登录', 'AUTH_REQUIRED');
      const next = await transaction(pool, async client => {
        const refreshHash = digest(refreshToken);
        const { rows: [candidate] } = await client.query('SELECT s.user_id,u.store_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.refresh_hash=$1 OR s.previous_refresh_hash=$1', [refreshHash]);
        if (!candidate) return null;
        const entitlements = await storeEntitlement(client, candidate.store_id);
        // 与权限变更保持先用户、后会话的锁定顺序，避免互相等待。
        const { rows: [user] } = await client.query('SELECT * FROM users WHERE id=$1 FOR SHARE', [candidate.user_id]);
        if (!user?.active || user.historical_only) return null;
        if (user.platform_disabled) throw new ApiError(403, '账号已被平台禁用', 'USER_DISABLED');
        const { rows: [session] } = await client.query('SELECT * FROM sessions WHERE refresh_hash=$1 OR previous_refresh_hash=$1 FOR UPDATE', [refreshHash]);
        if (!session || session.revoked) return null;
        // The request cannot upgrade a stored web credential to a perpetual session.
        const kind = session.client_kind === 'native' ? 'native' : 'web';
        if (kind !== 'native' && new Date(session.expires_at) <= new Date()) return null;
        const authorization = commercialGrant(deviceGrant(await ensureDevice(client, user, session.device_id, kind, deviceFingerprint, deviceName)), entitlements, user);
        // Keep the refresh credential stable. Accept the last rotated legacy credential,
        // including a refresh whose response was lost, without revoking other requests.
        const accessToken = digest('access:' + refreshToken), [accessExpires] = sessionTimes();
        await client.query('UPDATE sessions SET previous_access_hash=CASE WHEN access_hash<>$1 THEN access_hash ELSE previous_access_hash END,previous_access_expires_at=CASE WHEN access_hash<>$1 THEN access_expires_at ELSE previous_access_expires_at END,access_hash=$1,access_expires_at=$2,client_kind=$3,expires_at=CASE WHEN $3=\'native\' THEN \'infinity\'::timestamptz ELSE expires_at END WHERE id=$4',
          [digest(accessToken), accessExpires, kind, session.id]);
        return { accessToken, refreshToken, user: publicUser(user), expiresAt: accessExpires.toISOString(), authorization, entitlements, storeProfile: await readStoreProfile(client, user.store_id) };
      });
      if (!next) throw new ApiError(401, '登录已失效，请重新登录', 'AUTH_REQUIRED');
      return next;
    },
    async logout(user) { await pool.query('UPDATE sessions SET revoked=true WHERE id=$1', [user.sessionId]); },
    async deviceAuthorization(identity) {
      // Update the heartbeat before shared authorization locks are acquired. Multiple
      // sessions on the same phone must not both upgrade a shared device lock.
      await pool.query('UPDATE app_devices SET last_seen_at=now() WHERE store_id=$1 AND device_id=$2', [identity.store_id, identity.device_id]);
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        const device = await checkDevice(client, user.store_id, user.device_id) || await ensureDevice(client, user, user.device_id);
        return { authorization: commercialGrant(deviceGrant(device), user.entitlements, user), entitlements: user.entitlements, user: publicUser(user), storeProfile: await readStoreProfile(client, user.store_id) };
      });
    },
    async devices(identity) {
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        requireFeature(user.entitlements, 'devices');
        if (user.role !== 'owner') throw new ApiError(403, '仅店主可以管理设备');
        return (await client.query(`SELECT d.*,u.display_name FROM app_devices d LEFT JOIN users u ON u.id=d.last_user_id
          WHERE d.store_id=$1 ORDER BY d.last_seen_at DESC`, [user.store_id])).rows.map(d => ({
          deviceId: d.device_id, deviceName: d.device_name, kind: d.kind, label: d.label, displayName: d.display_name,
          active: d.active, offlineHours: d.offline_hours, authorizedUntil: d.authorized_until,
          lastSeenAt: d.last_seen_at, createdAt: d.created_at
        }));
      });
    },
    async updateDevice(identity, deviceId, input) {
      if (typeof input.active !== 'boolean' || !Number.isInteger(input.offlineHours) || input.offlineHours < 0 || input.offlineHours > 8760 ||
          typeof input.label !== 'string' || input.label.length > 128 ||
          input.authorizedUntil !== null && (typeof input.authorizedUntil !== 'string' || !Number.isFinite(Date.parse(input.authorizedUntil)))) {
        throw new ApiError(400, '设备授权资料无效');
      }
      return transaction(pool, async client => {
        await client.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE', [identity.store_id]);
        const user = await lockedUser(client, identity);
        requireFeature(user.entitlements, 'devices');
        if (user.role !== 'owner') throw new ApiError(403, '仅店主可以管理设备');
        const { rowCount } = await client.query(`UPDATE app_devices SET active=$1,offline_hours=$2,authorized_until=$3,label=$4
          WHERE store_id=$5 AND (device_id=$6 OR hardware_fingerprint=(SELECT hardware_fingerprint FROM app_devices WHERE store_id=$5 AND device_id=$6))`, [input.active, input.offlineHours, input.authorizedUntil, input.label.trim(), user.store_id, deviceId]);
        if (!rowCount) throw new ApiError(404, '设备不存在');
        await audit(client, user, 'device_authorization_changed', { targetDeviceId: deviceId, ...input });
        return { success: true };
      });
    },
    async storeProfile(identity) {
      return transaction(pool, async client => { const user = await lockedUser(client, identity); return readStoreProfile(client, user.store_id); });
    },
    async saveStoreProfile(identity, input) {
      if (!input?.profile || typeof input.profile !== 'object' || Array.isArray(input.profile)) throw new ApiError(400, '请提交完整的门店设置');
      let profile;
      try { profile = normalizeStoreProfile(input.profile); } catch (error) { throw new ApiError(400, error.message); }
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new ApiError(400, '门店设置版本无效');
      return transaction(pool, async client => {
        await client.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE', [identity.store_id]);
        const user = await lockedUser(client, identity);
        requireFeature(user.entitlements, 'settings');
        if (user.role !== 'owner') throw new ApiError(403, '仅店主可以修改门店设置');
        const { rows: [updated] } = await client.query('UPDATE stores SET name=$1,profile=$2,profile_version=profile_version+1 WHERE id=$3 AND profile_version=$4 RETURNING profile_version',
          [profile.name, profile, user.store_id, input.expectedVersion]);
        if (!updated) throw new ApiError(409, '门店设置已被其他页面修改，请重新加载后核对', 'STORE_PROFILE_CHANGED');
        await audit(client, user, 'store_profile_changed', { name: profile.name, version: updated.profile_version });
        return { ...profile, version: updated.profile_version };
      });
    },
    async users(identity) {
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        requireFeature(user.entitlements, 'staff');
        if (user.role !== 'owner') throw new ApiError(403, '仅店主可以管理账号');
        const { rows } = await client.query('SELECT id,store_id,username,display_name,role,active,platform_disabled FROM users WHERE store_id=$1 AND historical_only=false ORDER BY created_at', [user.store_id]);
        return rows.map(member => ({ ...publicUser(member), active: member.active, platformDisabled: member.platform_disabled }));
      });
    },
    async createUser(identity, input) {
      await authorize(identity, 'owner');
      const username = normalizeUsername(input.username);
      boundedText(input.displayName, 128, '显示名', true);
      if (!['owner', 'clerk', 'viewer'].includes(input.role) || typeof input.displayName !== 'string' || !input.displayName.trim()) throw new ApiError(400, '账号资料无效');
      const passwordHash = await hashPassword(input.password);
      return transaction(pool, async client => {
        await client.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE', [identity.store_id]);
        const user = await lockedUser(client, identity);
        requireFeature(user.entitlements, 'staff');
        if (user.role !== 'owner') throw new ApiError(403, '仅店主可以管理账号');
        const { rows: [count] } = await client.query('SELECT count(*)::int AS count FROM users WHERE store_id=$1 AND historical_only=false', [user.store_id]);
        if (count.count >= 100) throw new ApiError(413, '账号数量已达到 100 个上限', 'DATA_LIMIT');
        const id = randomUUID();
        await client.query('INSERT INTO users(id,store_id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5,$6)', [id, user.store_id, username, input.displayName.trim(), passwordHash, input.role]);
        await audit(client, user, 'user_created', { targetUserId: id, role: input.role });
        return { id };
      });
    },
    async updateUser(identity, id, input) {
      if (!['owner', 'clerk', 'viewer'].includes(input.role) || typeof input.active !== 'boolean') throw new ApiError(400, '权限资料无效');
      return transaction(pool, async client => {
        // 管理员变更统一按门店锁定，防止两个请求同时撤销最后一位店主。
        await client.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE', [identity.store_id]);
        const user = await lockedUser(client, identity);
        requireFeature(user.entitlements, 'staff');
        if (user.role !== 'owner') throw new ApiError(403, '仅店主可以管理账号');
        const { rows } = await client.query('SELECT id,role,active,platform_disabled,historical_only FROM users WHERE store_id=$1 FOR UPDATE', [user.store_id]);
        const target = rows.find(row => row.id === id);
        if (!target) throw new ApiError(404, '账号不存在');
        if (target.historical_only) throw new ApiError(409, '历史操作人引用不能启用或修改', 'HISTORICAL_ACTOR');
        if (target.role === 'owner' && target.active && !target.platform_disabled && (!input.active || input.role !== 'owner') && rows.filter(row => row.active && !row.platform_disabled && row.role === 'owner').length === 1) throw new ApiError(409, '必须保留至少一位在用店主');
        await client.query('UPDATE users SET role=$1,active=$2,version=version+1 WHERE id=$3 AND store_id=$4', [input.role, input.active, id, user.store_id]);
        await client.query('UPDATE sessions SET revoked=true WHERE user_id=$1', [id]);
        await audit(client, user, 'user_permissions_changed', { targetUserId: id, role: input.role, active: input.active });
        return { success: true };
      });
    },
    async activity(identity, events) {
      if (!Array.isArray(events) || events.length > 100) throw new ApiError(400, '使用记录格式无效');
      try { assertJsonBudget(events, 64 * 1024); } catch (error) { throw new ApiError(error.status || 400, error.message, error.code); }
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        for (const event of events) {
          if (!event || typeof event.id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(event.id) || !['online', 'offline', 'sync_conflict_resolved'].includes(event.type) || typeof event.at !== 'string' || event.at.length > 64 || !Number.isFinite(Date.parse(event.at))) throw new ApiError(400, '使用记录格式无效');
          if (event.actorId !== user.id || event.deviceId !== user.device_id) throw new ApiError(403, '使用记录账号或设备不匹配', 'FORBIDDEN');
          await client.query('INSERT INTO audit_events(store_id,user_id,device_id,event,occurred_at,client_event_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(store_id,client_event_id) DO NOTHING',
            [user.store_id, user.id, user.device_id, event.type, event.at, event.id]);
        }
        return { success: true };
      });
    },
    async auditLog(identity, { before = null, limit = 100 } = {}) {
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        if (user.role !== 'owner') throw new ApiError(403, '仅店主可以查看使用记录');
        if (!/^[1-9]\d{0,2}$/.test(String(limit)) || Number(limit) > 500 ||
            before !== null && (!/^[1-9]\d{0,18}$/.test(String(before)) || BigInt(before) > 9223372036854775807n)) throw new ApiError(400, '审计日志分页参数无效');
        return (await client.query('SELECT a.id,a.event,a.device_id,a.details,a.occurred_at,a.received_at,u.display_name FROM audit_events a LEFT JOIN users u ON u.id=a.user_id WHERE a.store_id=$1 AND ($2::bigint IS NULL OR a.id<$2::bigint) ORDER BY a.id DESC LIMIT $3', [user.store_id, before, Number(limit)])).rows;
      });
    },
    async getAliGenieDevices(identity) {
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        requireFeature(user.entitlements, 'voice');
        if (user.role !== 'owner') throw new ApiError(403, '仅店主可以查看待绑定音箱');
        const { rows: [settings] } = await client.query('SELECT voice_config FROM store_settings WHERE store_id=$1', [user.store_id]);
        const config = settings?.voice_config?.aligenie;
        if (!config?.enabled || config.authVersion !== 2 || !config.token) return [];
        return (await client.query(`SELECT device_open_id AS "deviceOpenId",request_id AS "requestId",intent_name AS "intentName",
          first_seen_at AS "firstSeenAt",last_seen_at AS "lastSeenAt" FROM voice_device_candidates
          WHERE store_id=$1 AND credential_scope=$2 AND last_seen_at>=now()-interval '1 day'
          AND NOT(device_open_id=ANY($3::text[])) ORDER BY last_seen_at DESC,device_open_id LIMIT 20`,
          [user.store_id, aliGenieDeviceScope(config), config.allowedDevices || []])).rows;
      });
    },
    async getVoiceConfig(identity) {
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        requireFeature(user.entitlements, 'voice');
        const { rows } = await client.query('SELECT voice_config,voice_config_version FROM store_settings WHERE store_id=$1', [user.store_id]);
        const saved = rows[0]?.voice_config || {};
        const config = readVoiceConfig(saved);
        return { ...publicVoiceConfig(config, user.role), version: rows[0]?.voice_config_version || 0, storeName: (await readStoreProfile(client, user.store_id)).name };
      });
    },
    async saveVoiceConfig(identity, input, expectedVersion) {
      return transaction(pool, async client => {
        await client.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE', [identity.store_id]);
        const user = await lockedUser(client, identity);
        requireFeature(user.entitlements, 'voice');
        if (user.role !== 'owner') throw new ApiError(403, '仅店主可以修改语音播报配置');
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new ApiError(400, '语音配置版本无效，请重新加载或更新客户端', 'VOICE_CONFIG_VERSION_REQUIRED');
        const { rows } = await client.query('SELECT voice_config,voice_config_version FROM store_settings WHERE store_id=$1 FOR UPDATE', [user.store_id]);
        const currentVersion = rows[0]?.voice_config_version || 0;
        if (expectedVersion !== currentVersion) throw new ApiError(409, '语音配置已被其他页面修改，请重新加载后再保存', 'VOICE_CONFIG_CHANGED');
        const previous = readVoiceConfig(rows[0]?.voice_config || {});
        if (rows[0]?.voice_config?.aligenie?.authVersion !== 2 && input?.aligenie?.token && input.aligenie.token === rows[0]?.voice_config?.aligenie?.token) throw new ApiError(400, '旧语音口令已泄漏，请生成新的随机签名密钥');
        const next = sanitizeVoiceConfig(input, previous);
        if (next.aligenie.enabled) {
          const { rows: [actor] } = await client.query('SELECT id,role,active FROM users WHERE store_id=$1 AND id=$2', [user.store_id, next.aligenie.actorId || null]);
          if (!actor?.active || actor.role === 'viewer' || !next.aligenie.token || !next.aligenie.allowedDevices.length || next.aligenie.authVersion !== 2) throw new ApiError(400, '启用语音记账须配置新签名密钥、在用记账账号和设备白名单');
        }
        const { rows: [saved] } = await client.query(
          'INSERT INTO store_settings(store_id, voice_config, voice_config_version, updated_at) VALUES($1, $2, 1, now()) ON CONFLICT(store_id) DO UPDATE SET voice_config=$2, voice_config_version=store_settings.voice_config_version+1, updated_at=now() RETURNING voice_config_version',
          [user.store_id, JSON.stringify(next)]
        );
        await audit(client, user, 'voice_config_updated', { provider: next.provider, enabled: next.enabled });
        return { ...publicVoiceConfig(next, user.role), version: saved.voice_config_version, storeName: (await readStoreProfile(client, user.store_id)).name };
      });
    },
    async synthesizeVoice(identity, options = {}) {
      if (activeSynthesis >= MAX_SYNTHESIS) throw new ApiError(429, '语音合成繁忙，请稍后重试', 'VOICE_BUSY');
      activeSynthesis++;
      try {
        const config = await transaction(pool, async client => {
          const user = await lockedUser(client, identity);
        requireFeature(user.entitlements, 'voice');
          if (options.test === true && user.role !== 'owner') throw new ApiError(403, '仅店主可以试听草稿配置');
          const { rows } = await client.query('SELECT voice_config FROM store_settings WHERE store_id=$1', [user.store_id]);
          const saved = readVoiceConfig(rows[0]?.voice_config || {});
          const ownerTest = user.role === 'owner' && options.test === true;
          if (!saved.enabled && !ownerTest) throw new ApiError(400, '语音播报功能未启用');
          return ownerTest ? sanitizeVoiceConfig(options, saved) : saved;
        });
        // No database connection or account/session lock is held during network IO.
        return await synthesizeTTS({ ...config, text: options.text, fetchFn, socketFn });
      } finally { activeSynthesis--; }
    },
    async handleAliGenieWebhook(body, { headers = {}, platformTokenAuthenticated = false, trace = null } = {}) {
      return handleAliGenieWebhook({ pool, body, headers, platformTokenAuthenticated, trace, executeRelationalVoice: relational.executeVoiceCommand });
    },
    async getAliGenieVerification(fileName) {
      return getAliGenieVerificationContent(fileName, pool);
    }
  };
}
