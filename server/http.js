import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { isIP } from 'node:net';
import { ApiError } from './security.js';

async function body(request) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw new ApiError(415, '请求必须使用 JSON');
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 20 * 1024 * 1024) throw new ApiError(413, '同步数据过大，请联系管理员分批迁移');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, '请求 JSON 无效'); }
}

export function createApi({ service, pool, allowedOrigins = ['https://localhost'], releaseDirectory = './releases', production = false }) {
  const origins = new Set(allowedOrigins);
  const server = createServer(async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Vary', 'Origin');
    try {
      if (production && request.headers['x-forwarded-proto'] !== 'https') throw new ApiError(400, '请使用 HTTPS');
      const origin = request.headers.origin;
      if (origin && !origins.has(origin)) throw new ApiError(403, '此客户端来源未获允许');
      if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
        response.writeHead(204); return response.end();
      }
      const path = new URL(request.url, 'http://internal').pathname;
      const route = request.method + ' ' + path;
      if (route === 'GET /api/health') return send(200, { status: 'ok' });
      if (route === 'POST /api/v1/auth/login') {
        const forwarded = String(request.headers['x-forwarded-for'] || '').split(',').at(-1).trim();
        const ip = production && isIP(forwarded) ? forwarded : request.socket.remoteAddress || 'unknown';
        return send(200, await service.login(await body(request), ip));
      }
      if (route === 'POST /api/v1/auth/refresh') return send(200, await service.refresh((await body(request)).refreshToken));
      const accessToken = /^Bearer ([a-zA-Z0-9_-]+)$/.exec(request.headers.authorization || '')?.[1];
      const identity = await service.authenticate(accessToken);
      if (route === 'POST /api/v1/auth/logout') { await service.logout(identity); return send(200, { success: true }); }
      if (route === 'GET /api/v1/account') return send(200, await service.account(identity));
      if (route === 'GET /api/v1/account/head') {
        const { revision, integrity } = await service.account(identity);
        return send(200, { revision, integrity });
      }
      if (route === 'POST /api/v1/account/bootstrap') return send(200, await service.bootstrap(identity, await body(request)));
      if (route === 'POST /api/v1/sync') return send(200, await service.sync(identity, (await body(request)).operations));
      if (route === 'GET /api/v1/users') return send(200, await service.users(identity));
      if (route === 'POST /api/v1/users') return send(201, await service.createUser(identity, await body(request)));
      if (request.method === 'PATCH' && /^\/api\/v1\/users\/[a-f0-9-]{36}$/.test(path)) return send(200, await service.updateUser(identity, path.split('/').at(-1), await body(request)));
      if (route === 'POST /api/v1/activity') return send(200, await service.activity(identity, (await body(request)).events));
      if (route === 'GET /api/v1/activity') return send(200, await service.auditLog(identity));
      if (route === 'GET /api/v1/updates/latest') {
        const { rows: [release] } = await pool.query('SELECT * FROM releases ORDER BY version_code DESC LIMIT 1');
        return send(200, release ? {
          versionCode: release.version_code, versionName: release.version_name, appId: release.app_id,
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
      if (response.headersSent) return response.destroy();
      const status = error.status || (error.code === '23505' ? 409 : error instanceof TypeError || error instanceof SyntaxError ? 400 : 500);
      if (status === 500) console.error('API 请求失败:', error.message);
      send(status, { error: status === 500 ? '服务暂时不可用，请稍后重试' : error.message, code: error.status ? error.code : 'REQUEST_FAILED' });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return server;
}
