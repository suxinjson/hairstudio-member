import { isIP } from 'node:net';
import { ApiError } from './security.js';

export function normalizeIP(value) {
  const text = String(value || '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  const candidate = mapped || text;
  return isIP(candidate) ? candidate : null;
}
export function proxyIdentity(request, production, trustedProxies) {
  const peer = normalizeIP(request.socket.remoteAddress);
  if (!production) return peer || 'unknown';
  if (!peer || !trustedProxies.has(peer)) throw new ApiError(400, '请求必须通过可信 HTTPS 代理', 'UNTRUSTED_PROXY');
  if (request.headers['x-forwarded-proto'] !== 'https') throw new ApiError(400, '请使用 HTTPS');
  // Closest client hop is appended by our proxy, regardless of forged earlier hops.
  const client = normalizeIP(String(request.headers['x-forwarded-for'] || '').split(',').at(-1).trim());
  if (!client) throw new ApiError(400, '代理客户端地址无效');
  return client;
}
export function createRequestGuard({ enabled = true, maxEntries = 10000, maxActive = 32, now = Date.now } = {}) {
  const windows = new Map(), running = new Map(); let active = 0;
  function take(key, maximum) {
    if (!enabled) return;
    const time = now(); let row = windows.get(key);
    if (!row || row.until <= time) {
      if (!row && windows.size >= maxEntries) {
        for (const [entry, window] of windows) if (window.until <= time) windows.delete(entry);
        if (windows.size >= maxEntries) throw new ApiError(503, '请求服务繁忙，请稍后重试', 'SERVER_BUSY');
      }
      row = { count: 0, until: time + 60000 }; windows.set(key, row);
    }
    if (++row.count > maximum) throw new ApiError(429, '请求过于频繁，请稍后重试', 'RATE_LIMITED');
  }
  return {
    take,
    enter(route = null, limit = maxActive) {
      if (enabled && active >= maxActive) throw new ApiError(503, '服务繁忙，请稍后重试', 'SERVER_BUSY');
      if (enabled && route && (running.get(route) || 0) >= limit) throw new ApiError(503, '此接口正在处理其他请求，请稍后重试', 'SERVER_BUSY');
      if (route) running.set(route, (running.get(route) || 0) + 1);
      active++; let released = false;
      return () => { if (!released) { released = true; active--; if (route) running.set(route, running.get(route) - 1); } };
    }
  };
}
