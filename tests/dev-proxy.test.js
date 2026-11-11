import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';

test('cashier development server forwards login and authenticated API requests to the backend', async () => {
  const requests = [];
  const backend = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, method: request.method, authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString() });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  let vite;
  try {
    vite = await createViteServer({
      configFile: fileURLToPath(new URL('../vite.config.js', import.meta.url)),
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }
    });
    const proxy = vite.config.server.proxy['/api'];
    assert.equal(proxy.target, 'http://127.0.0.1:48927');
    // Use an ephemeral backend port while exercising the checked-in proxy configuration.
    proxy.target = 'http://127.0.0.1:' + backend.address().port;
    await vite.listen();
    const origin = 'http://127.0.0.1:' + vite.httpServer.address().port;
    const body = JSON.stringify({ username: 'cashier', password: 'test-password' });
    const login = await fetch(origin + '/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body
    });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), { ok: true });
    const account = await fetch(origin + '/api/v1/account', { headers: { Authorization: 'Bearer test-token' } });
    assert.equal(account.status, 200);
    assert.deepEqual(requests, [
      { path: '/api/v1/auth/login', method: 'POST', authorization: undefined, body },
      { path: '/api/v1/account', method: 'GET', authorization: 'Bearer test-token', body: '' }
    ]);
  } finally {
    await vite?.close();
    backend.closeAllConnections();
    await new Promise(resolve => backend.close(resolve));
  }
});
