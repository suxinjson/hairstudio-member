import { ApiError } from './security.js';
export async function platformRoute({ platform, request, url, ip, readBody, guard }) {
  const path = url.pathname.slice('/api/platform/v1'.length) || '/', method = request.method;
  const result = (value, status = 200) => ({ status, value });
  if (path === '/auth/login' && method === 'POST') {
    guard.take('platform-login:' + ip, 20);
    return result(await platform.login(await readBody(request), ip));
  }
  const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization || '')?.[1];
  const identity = await platform.authenticate(bearer);
  guard.take('platform-session:' + identity.sessionId, 120);
  if (method !== 'GET') guard.take('platform-write:' + identity.id, 20);
  if (path === '/auth/me' && method === 'GET') return result(await platform.me(identity));
  if (path === '/auth/logout' && method === 'POST') return result(await platform.logout(identity));
  if (path === '/auth/password' && method === 'POST') return result(await platform.changePassword(identity, await readBody(request)));
  if (path === '/stores' && method === 'GET') return result(await platform.stores(identity, Object.fromEntries(url.searchParams)));
  if (path === '/stores' && method === 'POST') return result(await platform.createStore(identity, await readBody(request)), 201);
  const store = /^\/stores\/([a-f0-9-]{36})$/.exec(path);
  if (store && method === 'PATCH') return result(await platform.updateStore(identity, store[1], await readBody(request)));
  const users = /^\/stores\/([a-f0-9-]{36})\/users$/.exec(path);
  if (users && method === 'GET') return result(await platform.users(identity, users[1]));
  const user = /^\/users\/([a-f0-9-]{36})$/.exec(path);
  if (user && method === 'PATCH') return result(await platform.updateUser(identity, user[1], await readBody(request)));
  const license = /^\/stores\/([a-f0-9-]{36})\/license$/.exec(path);
  if (license && method === 'GET') return result(await platform.license(identity, license[1]));
  if (license && method === 'POST') return result(await platform.setLicense(identity, license[1], await readBody(request)));
  const offline = /^\/stores\/([a-f0-9-]{36})\/offline-licenses$/.exec(path);
  if (offline && method === 'POST') return result(await platform.issueOfflineLicense(identity, offline[1], await readBody(request)), 201);
  if (path === '/operators' && method === 'GET') return result(await platform.operators(identity));
  if (path === '/operators' && method === 'POST') return result(await platform.saveOperator(identity, null, await readBody(request)), 201);
  const operator = /^\/operators\/([a-f0-9-]{36})$/.exec(path);
  if (operator && method === 'PATCH') return result(await platform.saveOperator(identity, operator[1], await readBody(request)));
  if (path === '/logs' && method === 'GET') return result(await platform.logs(identity, Object.fromEntries(url.searchParams)));
  if (path === '/system' && method === 'GET') return result(await platform.system(identity));
  throw new ApiError(404, '平台接口不存在');
}
