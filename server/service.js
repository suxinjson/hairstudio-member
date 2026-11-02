import { randomUUID } from 'node:crypto';
import { transaction } from './database.js';
import { token, digest, integrity, hashPassword, verifyPassword, normalizeUsername, ApiError, publicUser } from './security.js';
import { createLocalDb, DEFAULT_SERVICES, DEFAULT_RECHARGE_PLANS } from '../src/storage.js';
import { replayOperation } from '../src/cloud-storage.js';
import { canWrite, canonicalJSON, validateOperation } from '../src/sync-protocol.js';

export function validateSnapshot(data) {
  const validated = createLocalDb(null).parseAndValidateBackup(JSON.stringify({ data })).data;
  for (const [items, label] of [[validated.services, '服务项目'], [validated.members, '会员']]) {
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error(label + '单号重复');
  }
  return validated;
}
const emptyData = () => ({ members: [], ledgers: [], services: DEFAULT_SERVICES, rechargePlans: DEFAULT_RECHARGE_PLANS });
const sessionTimes = () => [new Date(Date.now() + 15 * 60000), new Date(Date.now() + 30 * 86400000)];

export function createService(pool) {
  async function audit(client, user, event, details = {}, occurredAt = null) {
    await client.query('INSERT INTO audit_events(store_id,user_id,device_id,event,details,occurred_at) VALUES($1,$2,$3,$4,$5,$6)',
      [user.store_id, user.id, user.device_id || null, event, details, occurredAt]);
  }
  async function lockedUser(client, identity) {
    const { rows: [user] } = await client.query('SELECT u.*,s.device_id FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.id=$1 AND s.revoked=false AND s.expires_at>now() FOR SHARE OF u,s', [identity.sessionId]);
    if (!user?.active || user.id !== identity.id) throw new ApiError(401, '登录已失效，请重新登录', 'AUTH_REQUIRED');
    return user;
  }
  return {
    async createOwner({ username, password, displayName = '店主', storeName = '梦飞空间' }) {
      const passwordHash = await hashPassword(password);
      username = normalizeUsername(username);
      return transaction(pool, async client => {
        const storeId = randomUUID(), userId = randomUUID(), data = emptyData();
        await client.query('INSERT INTO stores(id,name) VALUES($1,$2)', [storeId, storeName]);
        await client.query('INSERT INTO users(id,store_id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5,$6)',
          [userId, storeId, username, displayName, passwordHash, 'owner']);
        await client.query('INSERT INTO accounts(store_id,data,integrity) VALUES($1,$2,$3)', [storeId, data, integrity(data)]);
        return { userId, storeId };
      });
    },
    async login({ username, password, deviceId }, ip) {
      if (typeof deviceId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(deviceId)) throw new ApiError(400, '设备标识无效');
      try { username = normalizeUsername(username); } catch { throw new ApiError(401, '账号或密码错误'); }
      const buckets = [digest('user:' + username), digest('ip:' + ip)];
      const limits = await pool.query("SELECT failures FROM login_limits WHERE bucket=ANY($1::text[]) AND window_start>now()-interval '15 minutes'", [buckets]);
      if (limits.rows.some(row => row.failures >= 10)) throw new ApiError(429, '尝试次数过多，请 15 分钟后再试', 'RATE_LIMITED');
      const { rows: [user] } = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
      if (!(await verifyPassword(password, user?.password_hash)) || !user?.active) {
        for (const bucket of buckets) await pool.query("INSERT INTO login_limits(bucket,failures) VALUES($1,1) ON CONFLICT(bucket) DO UPDATE SET failures=CASE WHEN login_limits.window_start<now()-interval '15 minutes' THEN 1 ELSE login_limits.failures+1 END, window_start=CASE WHEN login_limits.window_start<now()-interval '15 minutes' THEN now() ELSE login_limits.window_start END", [bucket]);
        throw new ApiError(401, '账号或密码错误', 'AUTH_REQUIRED');
      }
      const accessToken = token(), refreshToken = token(), sessionId = randomUUID();
      const [accessExpires, expires] = sessionTimes();
      const currentUser = await transaction(pool, async client => {
        const { rows: [current] } = await client.query('SELECT * FROM users WHERE id=$1 FOR SHARE', [user.id]);
        if (!current?.active || current.password_hash !== user.password_hash) throw new ApiError(401, '账号或密码错误');
        await client.query('INSERT INTO sessions(id,user_id,device_id,access_hash,refresh_hash,access_expires_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [sessionId, user.id, deviceId, digest(accessToken), digest(refreshToken), accessExpires, expires]);
        await audit(client, { ...current, device_id: deviceId }, 'login');
        return current;
      });
      return { accessToken, refreshToken, user: publicUser(currentUser), expiresAt: accessExpires.toISOString() };
    },
    async authenticate(accessToken) {
      if (typeof accessToken !== 'string' || accessToken.length > 128) throw new ApiError(401, '请登录', 'AUTH_REQUIRED');
      const { rows: [row] } = await pool.query('SELECT u.*,s.id AS session_id,s.device_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.access_hash=$1 AND s.revoked=false AND s.access_expires_at>now() AND s.expires_at>now() AND u.active=true', [digest(accessToken)]);
      if (!row) throw new ApiError(401, '登录已失效，请重新登录', 'AUTH_REQUIRED');
      return { ...row, sessionId: row.session_id };
    },
    async refresh(refreshToken) {
      if (typeof refreshToken !== 'string' || refreshToken.length > 128) throw new ApiError(401, '请重新登录', 'AUTH_REQUIRED');
      const next = await transaction(pool, async client => {
        const refreshHash = digest(refreshToken);
        const { rows: [candidate] } = await client.query('SELECT user_id FROM sessions WHERE refresh_hash=$1 OR previous_refresh_hash=$1', [refreshHash]);
        if (!candidate) return null;
        // 与权限变更保持先用户、后会话的锁定顺序，避免互相等待。
        const { rows: [user] } = await client.query('SELECT * FROM users WHERE id=$1 FOR SHARE', [candidate.user_id]);
        if (!user?.active) return null;
        const { rows: [session] } = await client.query('SELECT * FROM sessions WHERE refresh_hash=$1 OR previous_refresh_hash=$1 FOR UPDATE', [refreshHash]);
        if (!session || session.revoked || new Date(session.expires_at) <= new Date()) return null;
        if (session.refresh_hash !== digest(refreshToken)) {
          await client.query('UPDATE sessions SET revoked=true WHERE id=$1', [session.id]);
          return null;
        }
        const accessToken = token(), replacement = token(), [accessExpires] = sessionTimes();
        await client.query('UPDATE sessions SET access_hash=$1,previous_refresh_hash=refresh_hash,refresh_hash=$2,access_expires_at=$3 WHERE id=$4',
          [digest(accessToken), digest(replacement), accessExpires, session.id]);
        return { accessToken, refreshToken: replacement, user: publicUser(user), expiresAt: accessExpires.toISOString() };
      });
      if (!next) throw new ApiError(401, '登录已失效，请重新登录', 'AUTH_REQUIRED');
      return next;
    },
    async logout(user) { await pool.query('UPDATE sessions SET revoked=true WHERE id=$1', [user.sessionId]); },
    async account(identity) {
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        const { rows: [account] } = await client.query('SELECT * FROM accounts WHERE store_id=$1', [user.store_id]);
        if (integrity(account.data) !== account.integrity) throw new ApiError(503, '云端账本完整性检查失败，请联系管理员', 'INTEGRITY_FAILED');
        return { data: account.data, revision: account.revision, integrity: account.integrity };
      });
    },
    async bootstrap(identity, request) {
      let data;
      try { data = validateSnapshot(request.data); }
      catch (error) { throw new ApiError(400, error.message); }
      if (typeof request.id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(request.id)) throw new ApiError(400, '同步单号无效');
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        if (user.role !== 'owner') throw new ApiError(403, '仅店主可以迁移初始账本');
        const { rows: [account] } = await client.query('SELECT * FROM accounts WHERE store_id=$1 FOR UPDATE', [user.store_id]);
        const hash = integrity({ method: 'bootstrap', data });
        const { rows: [existing] } = await client.query('SELECT * FROM operations WHERE store_id=$1 AND id=$2', [user.store_id, request.id]);
        if (existing && existing.request_hash !== hash) throw new ApiError(409, '同一同步单号对应不同数据', 'SYNC_CONFLICT');
        if (!existing) {
          if (account.revision !== 0 || account.data.members.length || account.data.ledgers.length) throw new ApiError(409, '云端已有账本，不能再次初始化', 'SYNC_CONFLICT');
          await client.query('UPDATE accounts SET data=$1,revision=1,integrity=$2 WHERE store_id=$3', [data, integrity(data), user.store_id]);
          await client.query('INSERT INTO operations(store_id,id,user_id,device_id,method,request_hash,result,revision) VALUES($1,$2,$3,$4,$5,$6,$7,1)',
            [user.store_id, request.id, user.id, user.device_id, 'bootstrap', hash, { success: true }]);
          await audit(client, user, 'bootstrap', { memberCount: data.members.length, ledgerCount: data.ledgers.length });
        }
        const { rows: [next] } = await client.query('SELECT * FROM accounts WHERE store_id=$1', [user.store_id]);
        return { data: next.data, revision: next.revision, integrity: next.integrity, acknowledged: [request.id] };
      });
    },
    async sync(identity, operations) {
      if (!Array.isArray(operations) || operations.length > 100 || new Set(operations.map(op => op?.id)).size !== operations.length) throw new ApiError(400, '同步批次格式无效');
      try { operations.forEach(validateOperation); }
      catch (error) { throw new ApiError(400, error.message); }
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        const { rows: [account] } = await client.query('SELECT * FROM accounts WHERE store_id=$1 FOR UPDATE', [user.store_id]);
        if (integrity(account.data) !== account.integrity) throw new ApiError(503, '云端账本完整性检查失败', 'INTEGRITY_FAILED');
        let data = account.data, revision = account.revision;
        for (const operation of operations) {
          if (!canWrite(user.role, operation.method)) throw new ApiError(403, '当前账号没有此操作权限', 'FORBIDDEN');
          if (operation.actorId !== user.id || operation.deviceId !== user.device_id) throw new ApiError(403, '操作账号或设备不匹配', 'FORBIDDEN');
          const hash = integrity(operation);
          const { rows: [existing] } = await client.query('SELECT * FROM operations WHERE store_id=$1 AND id=$2', [user.store_id, operation.id]);
          if (existing) {
            if (existing.request_hash !== hash || existing.user_id !== user.id) throw new ApiError(409, '同一同步单号对应不同操作', 'SYNC_CONFLICT');
            continue;
          }
          let applied;
          try { applied = replayOperation(data, operation); data = validateSnapshot(applied.data); }
          catch (error) { throw new ApiError(409, error.message, 'SYNC_CONFLICT'); }
          revision++;
          await client.query('INSERT INTO operations(store_id,id,user_id,device_id,method,request_hash,result,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [user.store_id, operation.id, user.id, user.device_id, operation.method, hash, applied.result, revision]);
          await audit(client, user, operation.method, { operationId: operation.id }, operation.generated.times.at(-1) || null);
        }
        const checksum = integrity(data);
        await client.query('UPDATE accounts SET data=$1,revision=$2,integrity=$3 WHERE store_id=$4', [data, revision, checksum, user.store_id]);
        return { data, revision, integrity: checksum, acknowledged: operations.map(op => op.id) };
      });
    },
    async users(identity) {
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        if (user.role !== 'owner') throw new ApiError(403, '仅店主可以管理账号');
        const { rows } = await client.query('SELECT id,store_id,username,display_name,role,active FROM users WHERE store_id=$1 ORDER BY created_at', [user.store_id]);
        return rows.map(member => ({ ...publicUser(member), active: member.active }));
      });
    },
    async createUser(identity, input) {
      const username = normalizeUsername(input.username), passwordHash = await hashPassword(input.password);
      if (!['owner', 'clerk', 'viewer'].includes(input.role) || typeof input.displayName !== 'string' || !input.displayName.trim()) throw new ApiError(400, '账号资料无效');
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        if (user.role !== 'owner') throw new ApiError(403, '仅店主可以管理账号');
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
        if (user.role !== 'owner') throw new ApiError(403, '仅店主可以管理账号');
        const { rows } = await client.query('SELECT id,role,active FROM users WHERE store_id=$1 FOR UPDATE', [user.store_id]);
        const target = rows.find(row => row.id === id);
        if (!target) throw new ApiError(404, '账号不存在');
        if (target.role === 'owner' && target.active && (!input.active || input.role !== 'owner') && rows.filter(row => row.active && row.role === 'owner').length === 1) throw new ApiError(409, '必须保留至少一位在用店主');
        await client.query('UPDATE users SET role=$1,active=$2 WHERE id=$3 AND store_id=$4', [input.role, input.active, id, user.store_id]);
        await client.query('UPDATE sessions SET revoked=true WHERE user_id=$1', [id]);
        await audit(client, user, 'user_permissions_changed', { targetUserId: id, role: input.role, active: input.active });
        return { success: true };
      });
    },
    async activity(identity, events) {
      if (!Array.isArray(events) || events.length > 100) throw new ApiError(400, '使用记录格式无效');
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        for (const event of events) {
          if (!/^[a-zA-Z0-9-]{16,80}$/.test(event.id || '') || !['online', 'offline', 'sync_conflict_resolved'].includes(event.type) || !Number.isFinite(Date.parse(event.at))) throw new ApiError(400, '使用记录格式无效');
          if (event.actorId !== user.id || event.deviceId !== user.device_id) throw new ApiError(403, '使用记录账号或设备不匹配', 'FORBIDDEN');
          await client.query('INSERT INTO audit_events(store_id,user_id,device_id,event,occurred_at,client_event_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(store_id,client_event_id) DO NOTHING',
            [user.store_id, user.id, user.device_id, event.type, event.at, event.id]);
        }
        return { success: true };
      });
    },
    async auditLog(identity) {
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        if (user.role !== 'owner') throw new ApiError(403, '仅店主可以查看使用记录');
        return (await client.query('SELECT a.id,a.event,a.device_id,a.details,a.occurred_at,a.received_at,u.display_name FROM audit_events a LEFT JOIN users u ON u.id=a.user_id WHERE a.store_id=$1 ORDER BY a.id DESC LIMIT 100', [user.store_id])).rows;
      });
    }
  };
}
