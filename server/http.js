import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ApiError } from './security.js';
import { assertJsonBudget } from '../src/data-limits.js';
import { normalizeIP, proxyIdentity, createRequestGuard } from './request-guard.js';
import { signAliGenieRequest, formatAliGeniePlatformError, parseAliGenieRequest } from './aligenie.js';
import { createAliGenieTrace } from './aligenie-log.js';
import { randomUUID } from 'node:crypto';
import { createPlatformService } from './platform.js';
import { platformRoute } from './platform-http.js';
import { diagnosticRoute } from './diagnostics.js';
import { relationalRoute } from './relational-http.js';
import { PG_ARCHIVE_TIMEOUTS } from './relational-archive.js';

async function body(request, maximum = 16 * 1024) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw new ApiError(415, '请求必须使用 JSON');
  const chunks = []; let length = 0;
  if (Number(request.headers['content-length']) > maximum) throw new ApiError(413, '请求数据过大', 'DATA_LIMIT');
  // Let the HTTP layer flush its rejection before the connection closes.
  // Breaking IncomingMessage's default iterator destroys the socket first.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maximum) throw new ApiError(413, '请求数据过大', 'DATA_LIMIT');
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))); }
  catch { throw new ApiError(400, '请求 JSON 无效'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError(400, '请求必须是 JSON 对象');
  try { assertJsonBudget(parsed, maximum, maximum); }
  catch (error) { throw new ApiError(error.status || 400, error.message, error.code); }
  return parsed;
}

export function defaultAllowedOrigins(production = false) {
  return production ? ['https://localhost'] : ['https://localhost', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5174', 'http://127.0.0.1:5174'];
}

export function createApi({ service, pool, production = false, allowedOrigins = defaultAllowedOrigins(production), releaseDirectory = './releases', trustedProxyIPs = [], rateLimits = production, aligenieLogger = null, diagnostics = null, platform = createPlatformService(pool, { diagnostics }) }) {
  const origins = new Set(allowedOrigins);
  const trustedProxies = new Set(trustedProxyIPs.map(value => {
    const ip = normalizeIP(value); if (!ip) throw new Error('可信代理必须配置为明确的 IP 地址'); return ip;
  }));
  const guard = createRequestGuard({ enabled: rateLimits });
  const server = createServer(async (request, response) => {
    let voiceTrace = null;
    const started = performance.now(), requestId = randomUUID();
    let requestRoute = 'unknown', errorCode = null;
    response.setHeader('X-Request-Id', requestId);
    response.once('finish', () => diagnostics?.record({ requestId, route: requestRoute, status: response.statusCode, durationMs: performance.now() - started, errorCode }));
    const send = (status, value) => { voiceTrace?.response(status, value); response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Vary', 'Origin');
    let release = () => {}, workDone = false, responseDone = false;
    const finish = () => { responseDone = true; if (workDone) release(); };
    response.once('close', finish); response.once('finish', finish);
    try {
      const ip = proxyIdentity(request, production, trustedProxies);
      const url = new URL(request.url, 'http://internal');
      const path = url.pathname;
      const route = request.method + ' ' + path;
      requestRoute = diagnosticRoute(request.method, path);
      if (route === 'POST /api/v1/voice/aligenie') voiceTrace = createAliGenieTrace(aligenieLogger);
      const archiveUpload = /^POST \/api\/v2\/backup\/archive\/restore(?:\/preview)?$/.test(route);
      // Native requestTimeout is server-wide. Preserve the ordinary 30-second
      // body deadline while allowing the bounded streaming upload deadline.
      if (!archiveUpload && !request.complete) {
        const bodyTimer = setTimeout(() => request.destroy(), 30000); bodyTimer.unref?.();
        const clear = () => clearTimeout(bodyTimer); request.once('end', clear); response.once('close', clear);
      }
      const heavy = /^POST \/api\/v2\/import\/openings(?:\/preview)?$/.test(route) || /^(GET \/api\/v2\/backup(?:\/archive)?|POST \/api\/v2\/backup\/(?:archive\/)?restore(?:\/preview)?)$/.test(route);
      const batchSteps = /^POST \/api\/v2\/batches\/[a-zA-Z0-9-]{16,80}\/steps$/.test(route);
      const exportDownload = /^GET \/api\/v2\/exports\/ledger\/[0-9a-f-]{36}\/file$/.test(route);
      release = guard.enter(heavy || route === 'POST /api/v2/batches' || route === 'GET /api/v2/sync/snapshot' ? 'account' : batchSteps ? 'batch-steps' : exportDownload ? 'export-download' : null, 2);
      guard.take('ip:' + ip, 180);
      const origin = request.headers.origin;
      if (origin && !origins.has(origin)) throw new ApiError(403, '此客户端来源未获允许');
      if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
        response.writeHead(204); return response.end();
      }
      if (route === 'GET /api/health') return send(200, { status: 'ok' });
      if (route === 'GET /api/ready') {
        try { await pool.query('SELECT 1'); return send(200, { status: 'ready' }); }
        catch { throw new ApiError(503, '数据库暂不可用', 'DATABASE_UNAVAILABLE'); }
      }
      if (path.startsWith('/api/platform/v1/')) {
        const result = await platformRoute({ platform, request, url, ip, readBody: body, guard });
        return send(result.status, result.value);
      }
      if (route === 'POST /api/v1/auth/login') {
        guard.take('auth:' + ip, 30);
        return send(200, await service.login(await body(request), ip));
      }
      if (route === 'POST /api/v1/auth/refresh') {
        guard.take('auth:' + ip, 30);
        const input = await body(request);
        return send(200, await service.refresh(input.refreshToken, input.clientKind, input.deviceFingerprint, input.deviceName));
      }
      if (request.method === 'GET' && /^\/aligenie\/[a-zA-Z0-9_-]+\.txt$/.test(path)) {
        const fileName = path.split('/').at(-1);
        const content = await service.getAliGenieVerification(fileName);
        if (!content) throw new ApiError(404, '认证文件不存在');
        response.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        return response.end(content);
      }
      if (route === 'GET /api/v1/voice/aligenie') {
        return send(200, {
          status: 'ok',
          service: 'AliGenie Voice Webhook',
          time: new Date().toISOString()
        });
      }
      if (route === 'POST /api/v1/voice/aligenie') {
        guard.take('voice_aligenie:' + ip, 60);
        const input = await body(request, 32 * 1024);
        voiceTrace?.received(input, request.headers['x-aligenie-signature'] ? 'signed_request' : 'platform_or_unsigned');
        let headers = request.headers;
        let platformTokenAuthenticated = false;
        if (!headers['x-aligenie-signature']) {
          const rawToken = headers['x-aligenie-token'] || headers['x-token'] || url.searchParams.get('token');
          if (rawToken && typeof rawToken === 'string' && /^[a-zA-Z0-9_-]{32,100}$/.test(rawToken.trim())) {
            const token = rawToken.trim();
            const { rows } = await pool.query(
              "SELECT store_id, voice_config FROM store_settings WHERE voice_config->'aligenie'->>'token' = $1 LIMIT 1",
              [token]
            );
            if (rows[0] && rows[0].voice_config?.aligenie?.enabled) {
              const storeId = rows[0].store_id;
              const secret = rows[0].voice_config.aligenie.token;
              const timestamp = String(Date.now());
              headers = {
                ...request.headers,
                'x-store-id': storeId,
                'x-aligenie-timestamp': timestamp,
                'x-aligenie-signature': signAliGenieRequest(secret, timestamp, storeId, input)
              };
              platformTokenAuthenticated = true;
            }
          }
        }
        try {
          if (platformTokenAuthenticated) voiceTrace?.parsed(parseAliGenieRequest(input), input);
          const result = await service.handleAliGenieWebhook(input, { headers, platformTokenAuthenticated, trace: voiceTrace });
          return send(200, result);
        } catch (error) {
          voiceTrace?.reject(error);
          const reply = platformTokenAuthenticated && formatAliGeniePlatformError(error, input);
          if (reply) return send(200, reply);
          throw error;
        }
      }
      const accessToken = /^Bearer ([a-zA-Z0-9_-]+)$/.exec(request.headers.authorization || '')?.[1];
      const identity = await service.authenticate(accessToken);
      guard.take('session:' + identity.sessionId, 120);
      if (request.method !== 'GET') guard.take('write:' + identity.id, 30);
      if (path.startsWith('/api/v2/')) {
        const result = await relationalRoute({ ledger: service.relational, identity, request, response, url, readBody: body, guard });
        if (result.streamed) return;
        return send(result.status, result.value);
      }
      if (route === 'POST /api/v1/auth/logout') { await service.logout(identity); return send(200, { success: true }); }
      if (route === 'GET /api/v1/device/authorization') return send(200, await service.deviceAuthorization(identity));
      if (route === 'GET /api/v1/devices') return send(200, await service.devices(identity));
      if (route === 'GET /api/v1/store/profile') return send(200, await service.storeProfile(identity));
      if (route === 'PATCH /api/v1/store/profile') return send(200, await service.saveStoreProfile(identity, await body(request)));
      if (request.method === 'PATCH' && /^\/api\/v1\/devices\/[a-zA-Z0-9-]{16,80}$/.test(path)) {
        return send(200, await service.updateDevice(identity, path.split('/').at(-1), await body(request)));
      }
      if (route === 'GET /api/v1/users') return send(200, await service.users(identity));
      if (route === 'POST /api/v1/users') {
        await service.authorize(identity, 'owner'); guard.take('admin:' + identity.id, 10);
        return send(201, await service.createUser(identity, await body(request)));
      }
      if (request.method === 'PATCH' && /^\/api\/v1\/users\/[a-f0-9-]{36}$/.test(path)) {
        await service.authorize(identity, 'owner');
        return send(200, await service.updateUser(identity, path.split('/').at(-1), await body(request)));
      }
      if (route === 'POST /api/v1/activity') return send(200, await service.activity(identity, (await body(request, 64 * 1024)).events));
      if (route === 'GET /api/v1/activity') return send(200, await service.auditLog(identity, {
        before: url.searchParams.get('before'), limit: url.searchParams.get('limit') ?? 100
      }));
      if (route === 'GET /api/v1/voice/aligenie/devices') return send(200, await service.getAliGenieDevices(identity));
      if (route === 'GET /api/v1/voice/config') return send(200, await service.getVoiceConfig(identity));
      if (route === 'POST /api/v1/voice/config') {
        await service.authorize(identity, 'owner'); guard.take('admin:' + identity.id, 10);
        const input = await body(request, 8 * 1024);
        const { expectedVersion, ...config } = input;
        return send(200, await service.saveVoiceConfig(identity, config, expectedVersion));
      }
      if (route === 'POST /api/v1/voice/synthesize') {
        guard.take('voice:' + identity.id, 30);
        const input = await body(request, 8 * 1024);
        const { buffer, contentType } = await service.synthesizeVoice(identity, input);
        response.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': buffer.length,
          'Cache-Control': 'no-store'
        });
        return response.end(buffer);
      }
      if (route === 'GET /api/v1/updates/latest') {
        if (url.searchParams.get('channel') !== 'relational-v2') return send(200, { available: false });
        const { rows: [release] } = await pool.query('SELECT * FROM releases ORDER BY version_code DESC LIMIT 1');
        return send(200, release ? {
          channel: 'relational-v2', versionCode: release.version_code, versionName: release.version_name, appId: release.app_id,
          sha256: release.sha256, size: Number(release.size), certificateSha256: release.certificate_sha256,
          minSdk: release.min_sdk, notes: release.notes, downloadPath: '/api/v1/updates/files/' + release.sha256 + '.apk'
        } : { available: false });
      }
      if (request.method === 'GET' && /^\/api\/v1\/updates\/files\/[a-f0-9]{64}\.apk$/.test(path)) {
        const fileName = path.split('/').at(-1);
        const { rows: [release] } = await pool.query('SELECT size FROM releases WHERE file_name=$1', [fileName]);
        if (!release) throw new ApiError(404, '更新文件不存在');
        const filePath = join(resolve(releaseDirectory), fileName);
        const info = await stat(filePath);
        if (!info.isFile() || info.size !== Number(release.size)) throw new ApiError(503, '更新文件损坏，请联系管理员');
        response.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': info.size,
          'Content-Disposition': 'attachment; filename="' + fileName + '"' });
        createReadStream(filePath).on('error', () => response.destroy()).pipe(response);
        return;
      }
      throw new ApiError(404, '接口不存在');
    } catch (error) {
      errorCode = error.status ? error.code : 'REQUEST_FAILED';
      if (response.headersSent) return response.destroy();
      const status = error.status || (error.code === '23505' ? 409 : error instanceof TypeError || error instanceof SyntaxError ? 400 : 500);
      voiceTrace?.reject(error, status);
      if (status === 500 && !voiceTrace) console.error('API 请求失败:', requestId, error.code || 'INTERNAL_ERROR');
      if (status === 429 || status === 503) response.setHeader('Retry-After', status === 429 ? '60' : '5');
      if (!request.complete || status === 413) response.setHeader('Connection', 'close');
      send(status, { error: status === 500 ? '服务暂时不可用，请稍后重试' : error.message, code: error.status ? error.code : 'REQUEST_FAILED' });
    } finally {
      workDone = true;
      if (responseDone) release();
    }
  });
  server.requestTimeout = PG_ARCHIVE_TIMEOUTS.totalMs;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 256;
  return server;
}
