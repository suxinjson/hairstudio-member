import { randomUUID } from 'node:crypto';
import { transaction } from './database.js';
import { token, digest, integrity, hashPassword, verifyPassword, normalizeUsername, ApiError, publicUser } from './security.js';
import { createLocalDb, DEFAULT_SERVICES, DEFAULT_RECHARGE_PLANS } from '../src/storage.js';
import { replayOperation } from '../src/cloud-storage.js';
import { canWrite, canonicalJSON, validateOperation } from '../src/sync-protocol.js';
import { DATA_LIMITS, assertAccountLimits, assertJsonBudget, boundedText } from '../src/data-limits.js';
import { sanitizeVoiceConfig, readVoiceConfig, publicVoiceConfig, synthesizeTTS } from './voice.js';
import { handleAliGenieWebhook, getAliGenieVerificationContent, aliGenieDeviceScope } from './aligenie.js';
import { ensureDevice, checkDevice, deviceGrant } from './device-access.js';
import { readStoreProfile } from './store-profile.js';
import { normalizeStoreProfile } from '../src/store-profile.js';

export function validateSnapshot(data, options) {
  assertAccountLimits(data && { ...data, ledgers: data.ledgers ?? [], services: data.services ?? DEFAULT_SERVICES, rechargePlans: data.rechargePlans ?? DEFAULT_RECHARGE_PLANS });
  const validated = createLocalDb(null).parseAndValidateBackup(JSON.stringify({ data }), options).data;
  for (const [items, label] of [[validated.services, '服务项目'], [validated.members, '会员']]) {
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error(label + '单号重复');
  }
  return validated;
}
const emptyData = () => ({ members: [], ledgers: [], services: DEFAULT_SERVICES, rechargePlans: DEFAULT_RECHARGE_PLANS });
const sessionTimes = () => [new Date(Date.now() + 15 * 60000), new Date(Date.now() + 30 * 86400000)];
const importReceiptId = (signature, index) => 'IMPORT-' + signature + '-' + index;
function validateImportReceipt(value, operations) {
  if (!value || !/^[a-f0-9]{64}$/.test(value.signature || '') ||
      !/^[a-zA-Z0-9-]{16,80}$/.test(value.taskId || '') ||
      !Number.isInteger(value.totalBatches) || value.totalBatches < 1 || value.totalBatches > 10000 ||
      !Number.isInteger(value.batchIndex) || value.batchIndex < 0 || value.batchIndex >= value.totalBatches ||
      !Number.isInteger(value.total) || value.total < 1 || value.total > 10000 ||
      !Number.isInteger(value.count) || value.count < 1 || value.count > 50 || value.count > value.total ||
      operations.length < value.count || operations.length > value.count * 2 ||
      operations.some(op => !['createMember', 'updateMember', 'consume', 'recharge'].includes(op.method))) {
    throw new ApiError(400, '导入批次标识无效');
  }
}

let activeSynthesis = 0;
const MAX_SYNTHESIS = 4;

export function createService(pool, { fetchFn, socketFn } = {}) {
  async function importReceipts(client, user, signature) {
    return (await client.query("SELECT request_hash,result FROM operations WHERE store_id=$1 AND method='admin_import_batch' AND id LIKE $2 ORDER BY (result->>'batchIndex')::int", [user.store_id, 'IMPORT-' + signature + '-%'])).rows;
  }
  const importStatus = rows => rows.length ? {
    taskId: rows[0].result.taskId, total: rows[0].result.total,
    count: rows.reduce((sum, row) => sum + row.result.count, 0),
    status: rows.length === rows[0].result.totalBatches ? 'complete' : 'pending'
  } : null;
  async function audit(client, user, event, details = {}, occurredAt = null) {
    await client.query('INSERT INTO audit_events(store_id,user_id,device_id,event,details,occurred_at) VALUES($1,$2,$3,$4,$5,$6)',
      [user.store_id, user.id, user.device_id || null, event, details, occurredAt]);
  }
  async function lockedUser(client, identity) {
    const { rows: [user] } = await client.query('SELECT u.*,s.device_id FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.id=$1 AND s.revoked=false AND s.expires_at>now() FOR SHARE OF u,s', [identity.sessionId]);
    if (!user?.active || user.id !== identity.id) throw new ApiError(401, '登录已失效，请重新登录', 'AUTH_REQUIRED');
    await checkDevice(client, user.store_id, user.device_id);
    return user;
  }
  async function authorize(identity, permission) {
    return transaction(pool, async client => {
      const user = await lockedUser(client, identity);
      if (permission === 'owner' && user.role !== 'owner' || permission === 'write' && user.role === 'viewer') throw new ApiError(403, '当前账号没有此操作权限', 'FORBIDDEN');
      return user;
    });
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
  return {
    authorize,
    async createOwner({ username, password, displayName = '店主', storeName = '我的门店' }) {
      username = normalizeUsername(username);
      boundedText(displayName, 128, '显示名', true); boundedText(storeName, 128, '门店名', true);
      const passwordHash = await hashPassword(password);
      return transaction(pool, async client => {
        const storeId = randomUUID(), userId = randomUUID(), data = emptyData();
        await client.query('INSERT INTO stores(id,name) VALUES($1,$2)', [storeId, storeName]);
        await client.query('INSERT INTO users(id,store_id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5,$6)',
          [userId, storeId, username, displayName, passwordHash, 'owner']);
        await client.query('INSERT INTO accounts(store_id,data,integrity) VALUES($1,$2,$3)', [storeId, data, integrity(data)]);
        return { userId, storeId };
      });
    },
    async login({ username, password, deviceId, clientKind = 'web', deviceFingerprint = null, deviceName = '' }, ip) {
      if (!['native', 'web'].includes(clientKind)) throw new ApiError(400, '客户端类型无效');
      if (typeof deviceId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(deviceId)) throw new ApiError(400, '设备标识无效');
      try { username = normalizeUsername(username); } catch { throw new ApiError(401, '账号或密码错误'); }
      const reserved = await reserveLogin(username, ip);
      const { rows: [user] } = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
      let valid;
      try { valid = await verifyPassword(password, user?.password_hash); }
      catch (error) { await releaseLogin(reserved); throw error; }
      if (!valid || !user?.active) {
        throw new ApiError(401, '账号或密码错误', 'AUTH_REQUIRED');
      }
      const accessToken = token(), refreshToken = token(), sessionId = randomUUID();
      const [accessExpires, expires] = sessionTimes();
      let authorization, storeProfile;
      const currentUser = await transaction(pool, async client => {
        const { rows: [current] } = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [user.id]);
        if (!current?.active || current.password_hash !== user.password_hash) throw new ApiError(401, '账号或密码错误');
        await client.query("DELETE FROM sessions WHERE user_id=$1 AND expires_at<now()", [user.id]);
        authorization = deviceGrant(await ensureDevice(client, current, deviceId, clientKind, deviceFingerprint, deviceName));
        storeProfile = await readStoreProfile(client, current.store_id);
        await client.query('INSERT INTO sessions(id,user_id,device_id,access_hash,refresh_hash,access_expires_at,expires_at,client_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [sessionId, user.id, deviceId, digest(accessToken), digest(refreshToken), accessExpires, clientKind === 'native' ? 'infinity' : expires, clientKind]);
        await audit(client, { ...current, device_id: deviceId }, 'login');
        return current;
      });
      await releaseLogin(reserved);
      return { accessToken, refreshToken, user: publicUser(currentUser), expiresAt: accessExpires.toISOString(), authorization, storeProfile };
    },
    async authenticate(accessToken) {
      if (typeof accessToken !== 'string' || accessToken.length > 128) throw new ApiError(401, '请登录', 'AUTH_REQUIRED');
      const { rows: [row] } = await pool.query('SELECT u.*,s.id AS session_id,s.device_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE ((s.access_hash=$1 AND s.access_expires_at>now()) OR (s.previous_access_hash=$1 AND s.previous_access_expires_at>now())) AND s.revoked=false AND s.expires_at>now() AND u.active=true', [digest(accessToken)]);
      if (!row) throw new ApiError(401, '登录已失效，请重新登录', 'AUTH_REQUIRED');
      await transaction(pool, client => checkDevice(client, row.store_id, row.device_id));
      return { ...row, sessionId: row.session_id };
    },
    async refresh(refreshToken, clientKind, deviceFingerprint = null, deviceName = '') {
      if (typeof refreshToken !== 'string' || refreshToken.length > 128) throw new ApiError(401, '请重新登录', 'AUTH_REQUIRED');
      const next = await transaction(pool, async client => {
        const refreshHash = digest(refreshToken);
        const { rows: [candidate] } = await client.query('SELECT user_id FROM sessions WHERE refresh_hash=$1 OR previous_refresh_hash=$1', [refreshHash]);
        if (!candidate) return null;
        // 与权限变更保持先用户、后会话的锁定顺序，避免互相等待。
        const { rows: [user] } = await client.query('SELECT * FROM users WHERE id=$1 FOR SHARE', [candidate.user_id]);
        if (!user?.active) return null;
        const { rows: [session] } = await client.query('SELECT * FROM sessions WHERE refresh_hash=$1 OR previous_refresh_hash=$1 FOR UPDATE', [refreshHash]);
        if (!session || session.revoked) return null;
        // The request cannot upgrade a stored web credential to a perpetual session.
        const kind = session.client_kind === 'native' ? 'native' : 'web';
        if (kind !== 'native' && new Date(session.expires_at) <= new Date()) return null;
        const authorization = deviceGrant(await ensureDevice(client, user, session.device_id, kind, deviceFingerprint, deviceName));
        // Keep the refresh credential stable. Accept the last rotated legacy credential,
        // including a refresh whose response was lost, without revoking other requests.
        const accessToken = digest('access:' + refreshToken), [accessExpires] = sessionTimes();
        await client.query('UPDATE sessions SET previous_access_hash=CASE WHEN access_hash<>$1 THEN access_hash ELSE previous_access_hash END,previous_access_expires_at=CASE WHEN access_hash<>$1 THEN access_expires_at ELSE previous_access_expires_at END,access_hash=$1,access_expires_at=$2,client_kind=$3,expires_at=CASE WHEN $3=\'native\' THEN \'infinity\'::timestamptz ELSE expires_at END WHERE id=$4',
          [digest(accessToken), accessExpires, kind, session.id]);
        return { accessToken, refreshToken, user: publicUser(user), expiresAt: accessExpires.toISOString(), authorization, storeProfile: await readStoreProfile(client, user.store_id) };
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
        return { authorization: deviceGrant(device), user: publicUser(user), storeProfile: await readStoreProfile(client, user.store_id) };
      });
    },
    async devices(identity) {
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
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
        if (user.role !== 'owner') throw new ApiError(403, '仅店主可以修改门店设置');
        const { rows: [updated] } = await client.query('UPDATE stores SET name=$1,profile=$2,profile_version=profile_version+1 WHERE id=$3 AND profile_version=$4 RETURNING profile_version',
          [profile.name, profile, user.store_id, input.expectedVersion]);
        if (!updated) throw new ApiError(409, '门店设置已被其他页面修改，请重新加载后核对', 'STORE_PROFILE_CHANGED');
        await audit(client, user, 'store_profile_changed', { name: profile.name, version: updated.profile_version });
        return { ...profile, version: updated.profile_version };
      });
    },
    async account(identity) {
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        const { rows: [account] } = await client.query('SELECT * FROM accounts WHERE store_id=$1', [user.store_id]);
        if (integrity(account.data) !== account.integrity) throw new ApiError(503, '云端账本完整性检查失败，请联系管理员', 'INTEGRITY_FAILED');
        return { data: account.data, revision: account.revision, integrity: account.integrity, storeProfile: await readStoreProfile(client, user.store_id) };
      });
    },
    async reconcileAccount(identity, expectedHead) {
      if (!Number.isSafeInteger(expectedHead?.revision) || expectedHead.revision < 0 || !/^[a-f0-9]{64}$/.test(expectedHead.integrity || '')) throw new ApiError(400, '核对版本无效');
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        if (user.role !== 'owner') throw new ApiError(403, '仅店主可以重新确认账本版本');
        const { rows: [account] } = await client.query('SELECT * FROM accounts WHERE store_id=$1 FOR UPDATE', [user.store_id]);
        if (integrity(account.data) !== account.integrity) throw new ApiError(503, '云端数据损坏，请先修复服务器账本');
        if (account.revision !== expectedHead.revision || account.integrity !== expectedHead.integrity) throw new ApiError(409, '云端账本已变化，请重新导出核对');
        await audit(client, user, 'account_version_reconciled', { expectedHead });
        return { data: account.data, revision: account.revision, integrity: account.integrity };
      });
    },
    async bootstrap(identity, request) {
      await authorize(identity, 'owner');
      let data;
      try { data = validateSnapshot(request.data); }
      catch (error) { throw new ApiError(error.status || 400, error.message, error.code); }
      if (typeof request.id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(request.id)) throw new ApiError(400, '同步单号无效');
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        if (user.role !== 'owner') throw new ApiError(403, '仅店主可以迁移初始账本');
        const { rows: [account] } = await client.query('SELECT * FROM accounts WHERE store_id=$1 FOR UPDATE', [user.store_id]);
        const hash = integrity({ method: 'bootstrap', data });
        const { rows: [existing] } = await client.query('SELECT * FROM operations WHERE store_id=$1 AND id=$2', [user.store_id, request.id]);
        if (existing && (existing.request_hash !== hash || existing.user_id !== user.id || existing.device_id !== user.device_id)) throw new ApiError(409, '同一同步单号对应不同数据或设备', 'SYNC_CONFLICT');
        if (existing?.result?.cancelled === true) throw new ApiError(409, '此初始迁移已取消，请重新核对账本', 'OPERATION_CANCELLED');
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
    async importStatus(identity, signature) {
      if (!/^[a-f0-9]{64}$/.test(signature)) throw new ApiError(400, '导入任务标识无效');
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        if (user.role === 'viewer') throw new ApiError(403, '当前账号没有导入权限', 'FORBIDDEN');
        return { signature, ...(importStatus(await importReceipts(client, user, signature)) || { status: 'absent', count: 0 }) };
      });
    },
    async sync(identity, operations, importBatch = null, observedHead = null) {
      if (!Array.isArray(operations) || operations.length > 100 || new Set(operations.map(op => op?.id)).size !== operations.length) throw new ApiError(400, '同步批次格式无效');
      if (observedHead !== null && (!observedHead || !Number.isSafeInteger(observedHead.revision) || observedHead.revision < 0 ||
          typeof observedHead.integrity !== 'string' || !/^[a-f0-9]{64}$/.test(observedHead.integrity))) throw new ApiError(400, '同步账本版本格式无效');
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        for (const operation of operations) if (!canWrite(user.role, operation?.method)) throw new ApiError(403, '当前账号没有此操作权限', 'FORBIDDEN');
        try {
          assertJsonBudget(operations, operations.some(op => op?.method === 'importBackupData') ? DATA_LIMITS.restoreBytes : DATA_LIMITS.syncBytes, DATA_LIMITS.backupBytes);
          operations.forEach(validateOperation);
          if (importBatch !== null) { assertJsonBudget(importBatch, 1024); validateImportReceipt(importBatch, operations); }
        } catch (error) { throw new ApiError(error.status || 400, error.message, error.code); }
        for (const operation of operations) if (operation.actorId !== user.id || operation.deviceId !== user.device_id) throw new ApiError(403, '操作账号或设备不匹配', 'FORBIDDEN');
        const { rows: [account] } = await client.query('SELECT * FROM accounts WHERE store_id=$1 FOR UPDATE', [user.store_id]);
        if (integrity(account.data) !== account.integrity) throw new ApiError(503, '云端账本完整性检查失败', 'INTEGRITY_FAILED');
        // The account lock closes the gap between the client's head check and
        // this upload, including batches that could advance a rolled-back head.
        if (observedHead && (account.revision < observedHead.revision || account.revision === observedHead.revision && account.integrity !== observedHead.integrity)) {
          throw new ApiError(409, '云端账本版本核验失败，请先导出并核对账本', 'CLOUD_INTEGRITY_CONFLICT');
        }
        let receiptRows = [], receiptHash;
        if (importBatch !== null) {
          receiptRows = await importReceipts(client, user, importBatch.signature);
          const previous = importStatus(receiptRows);
          if (previous && previous.taskId !== importBatch.taskId) {
            if (previous.status === 'complete') return { data: account.data, revision: account.revision, integrity: account.integrity,
              acknowledged: operations.map(op => op.id), importReceipt: { signature: importBatch.signature, ...previous } };
            throw new ApiError(409, '这份数据已部分导入，请在原设备继续确认，或核对后仅导入剩余记录', 'IMPORT_ALREADY_STARTED');
          }
          if (previous && (previous.total !== importBatch.total || receiptRows[0].result.totalBatches !== importBatch.totalBatches)) throw new ApiError(409, '原导入任务的批次声明已变化', 'SYNC_CONFLICT');
          receiptHash = integrity({ operations, importBatch });
          const existingReceipt = receiptRows.find(row => row.result.batchIndex === importBatch.batchIndex);
          if (existingReceipt && existingReceipt.request_hash !== receiptHash) throw new ApiError(409, '原导入批次内容已变化', 'SYNC_CONFLICT');
          if (!existingReceipt && importBatch.batchIndex !== receiptRows.length) throw new ApiError(409, '请按原导入批次顺序继续确认', 'SYNC_CONFLICT');
        }
        let data = account.data, revision = account.revision;
        for (const operation of operations) {
          if (!canWrite(user.role, operation.method)) throw new ApiError(403, '当前账号没有此操作权限', 'FORBIDDEN');
          if (operation.actorId !== user.id || operation.deviceId !== user.device_id) throw new ApiError(403, '操作账号或设备不匹配', 'FORBIDDEN');
          const hash = integrity(operation);
          const { rows: [existing] } = await client.query('SELECT * FROM operations WHERE store_id=$1 AND id=$2', [user.store_id, operation.id]);
          if (existing) {
            if (existing.request_hash !== hash || existing.user_id !== user.id) throw new ApiError(409, '同一同步单号对应不同操作', 'SYNC_CONFLICT');
            if (existing.result?.cancelled === true) throw new ApiError(409, '此操作已取消，请重新核对后记账', 'OPERATION_CANCELLED');
            continue;
          }
          let applied;
          try { applied = replayOperation(data, operation); data = validateSnapshot(applied.data, { allowPhoneConflicts: operation.method === 'updateMember' }); }
          catch (error) { throw new ApiError(error.status || 409, error.message, error.code || 'SYNC_CONFLICT'); }
          revision++;
          await client.query('INSERT INTO operations(store_id,id,user_id,device_id,method,request_hash,result,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [user.store_id, operation.id, user.id, user.device_id, operation.method, hash, JSON.stringify(applied.result), revision]);
          await audit(client, user, operation.method, { operationId: operation.id }, operation.generated.times.at(-1) || null);
        }
        const checksum = integrity(data);
        await client.query('UPDATE accounts SET data=$1,revision=$2,integrity=$3 WHERE store_id=$4', [data, revision, checksum, user.store_id]);
        let receipt;
        if (importBatch !== null) {
          if (!receiptRows.some(row => row.result.batchIndex === importBatch.batchIndex)) {
            const count = receiptRows.reduce((sum, row) => sum + row.result.count, 0) + importBatch.count;
            if (count > importBatch.total || importBatch.batchIndex === importBatch.totalBatches - 1 && count !== importBatch.total) throw new ApiError(400, '导入进度与记录总数不一致');
            await client.query('INSERT INTO operations(store_id,id,user_id,device_id,method,request_hash,result,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
              [user.store_id, importReceiptId(importBatch.signature, importBatch.batchIndex), user.id, user.device_id, 'admin_import_batch', receiptHash, importBatch, revision]);
          }
          receipt = { signature: importBatch.signature, ...importStatus(await importReceipts(client, user, importBatch.signature)) };
        }
        return { data, revision, integrity: checksum, acknowledged: operations.map(op => op.id), ...(receipt ? { importReceipt: receipt } : {}) };
      });
    },
    async resolveOperations(identity, operations, bootstrap = null) {
      if (!Array.isArray(operations) || (!operations.length && !bootstrap) || operations.length > 100 ||
          (bootstrap && operations.length) ||
          (operations.some(op => op?.method === 'importBackupData') && operations.length !== 1) ||
          new Set(operations.map(op => op?.id)).size !== operations.length) throw new ApiError(400, '待确认操作格式无效');
      let bootstrapData;
      try {
        assertJsonBudget(operations, operations.some(op => op?.method === 'importBackupData') ? DATA_LIMITS.restoreBytes : DATA_LIMITS.syncBytes, DATA_LIMITS.backupBytes);
        operations.forEach(validateOperation);
        if (bootstrap) {
          assertJsonBudget(bootstrap, DATA_LIMITS.restoreBytes);
          if (typeof bootstrap.id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(bootstrap.id)) throw new Error('同步单号无效');
          bootstrapData = validateSnapshot(bootstrap.data);
        }
      } catch (error) { throw new ApiError(error.status || 400, error.message, error.code); }
      return transaction(pool, async client => {
        const user = await lockedUser(client, identity);
        // The same account lock used by sync fences requests still in flight.
        const { rows: [account] } = await client.query('SELECT * FROM accounts WHERE store_id=$1 FOR UPDATE', [user.store_id]);
        if (integrity(account.data) !== account.integrity) throw new ApiError(503, '云端账本完整性检查失败', 'INTEGRITY_FAILED');
        const resolved = [];
        const requests = bootstrap ? [{ id: bootstrap.id, method: 'bootstrap', actorId: user.id, deviceId: user.device_id }] : operations;
        for (const operation of requests) {
          if (operation.actorId !== user.id || operation.deviceId !== user.device_id) throw new ApiError(403, '操作账号或设备不匹配', 'FORBIDDEN');
          const hash = bootstrap ? integrity({ method: 'bootstrap', data: bootstrapData }) : integrity(operation);
          const { rows: [existing] } = await client.query('SELECT * FROM operations WHERE store_id=$1 AND id=$2', [user.store_id, operation.id]);
          if (existing && (existing.request_hash !== hash || existing.user_id !== user.id || existing.device_id !== user.device_id)) throw new ApiError(409, '同一同步单号对应不同操作或设备', 'SYNC_CONFLICT');
          if (!existing) {
            await client.query('INSERT INTO operations(store_id,id,user_id,device_id,method,request_hash,result,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
              [user.store_id, operation.id, user.id, user.device_id, operation.method, hash, { cancelled: true }, account.revision]);
            await audit(client, user, 'operation_cancelled', { operationId: operation.id, method: operation.method });
          }
          resolved.push({ id: operation.id, status: !existing || existing.result?.cancelled === true ? 'cancelled' : 'committed' });
        }
        return { data: account.data, revision: account.revision, integrity: account.integrity, resolved };
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
      await authorize(identity, 'owner');
      const username = normalizeUsername(input.username);
      boundedText(input.displayName, 128, '显示名', true);
      if (!['owner', 'clerk', 'viewer'].includes(input.role) || typeof input.displayName !== 'string' || !input.displayName.trim()) throw new ApiError(400, '账号资料无效');
      const passwordHash = await hashPassword(input.password);
      return transaction(pool, async client => {
        await client.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE', [identity.store_id]);
        const user = await lockedUser(client, identity);
        if (user.role !== 'owner') throw new ApiError(403, '仅店主可以管理账号');
        const { rows: [count] } = await client.query('SELECT count(*)::int AS count FROM users WHERE store_id=$1', [user.store_id]);
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
        const { rows } = await client.query('SELECT voice_config FROM store_settings WHERE store_id=$1', [user.store_id]);
        const saved = rows[0]?.voice_config || {};
        const config = readVoiceConfig(saved);
        return { ...publicVoiceConfig(config, user.role), storeName: (await readStoreProfile(client, user.store_id)).name };
      });
    },
    async saveVoiceConfig(identity, input) {
      return transaction(pool, async client => {
        await client.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE', [identity.store_id]);
        const user = await lockedUser(client, identity);
        if (user.role !== 'owner') throw new ApiError(403, '仅店主可以修改语音播报配置');
        const { rows } = await client.query('SELECT voice_config FROM store_settings WHERE store_id=$1 FOR UPDATE', [user.store_id]);
        const previous = readVoiceConfig(rows[0]?.voice_config || {});
        if (rows[0]?.voice_config?.aligenie?.authVersion !== 2 && input?.aligenie?.token && input.aligenie.token === rows[0]?.voice_config?.aligenie?.token) throw new ApiError(400, '旧语音口令已泄漏，请生成新的随机签名密钥');
        const next = sanitizeVoiceConfig(input, previous);
        if (next.aligenie.enabled) {
          const { rows: [actor] } = await client.query('SELECT id,role,active FROM users WHERE store_id=$1 AND id=$2', [user.store_id, next.aligenie.actorId || null]);
          if (!actor?.active || actor.role === 'viewer' || !next.aligenie.token || !next.aligenie.allowedDevices.length || next.aligenie.authVersion !== 2) throw new ApiError(400, '启用语音记账须配置新签名密钥、在用记账账号和设备白名单');
        }
        await client.query(
          'INSERT INTO store_settings(store_id, voice_config, updated_at) VALUES($1, $2, now()) ON CONFLICT(store_id) DO UPDATE SET voice_config=$2, updated_at=now()',
          [user.store_id, JSON.stringify(next)]
        );
        await audit(client, user, 'voice_config_updated', { provider: next.provider, enabled: next.enabled });
        return { ...publicVoiceConfig(next, user.role), storeName: (await readStoreProfile(client, user.store_id)).name };
      });
    },
    async synthesizeVoice(identity, options = {}) {
      if (activeSynthesis >= MAX_SYNTHESIS) throw new ApiError(429, '语音合成繁忙，请稍后重试', 'VOICE_BUSY');
      activeSynthesis++;
      try {
        const config = await transaction(pool, async client => {
          const user = await lockedUser(client, identity);
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
      return handleAliGenieWebhook({ pool, body, headers, platformTokenAuthenticated, trace });
    },
    async getAliGenieVerification(fileName) {
      return getAliGenieVerificationContent(fileName, pool);
    }
  };
}
