import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import WebSocket from 'ws';
import { ApiError } from './security.js';

const DEFAULT_ORIGINS = ['https://api.fish.audio', 'https://api.heygen.com', 'https://resource2.heygen.ai', 'https://files.heygen.ai', 'https://tts-api.xfyun.cn'];
export function voiceAllowedOrigins(extra = process.env.VOICE_ALLOWED_ORIGINS || '') {
  return new Set([...DEFAULT_ORIGINS, ...String(extra).split(',').map(value => value.trim()).filter(Boolean)].map(value => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || isIP(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('VOICE_ALLOWED_ORIGINS 必须为明确的 HTTPS 域名来源');
    return url.origin;
  }));
}
export function assertVoiceUrl(value, allowed = voiceAllowedOrigins()) {
  let url;
  try { url = new URL(value); } catch { throw new ApiError(400, '语音 API 地址无效', 'VOICE_TARGET_FORBIDDEN'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !allowed.has(url.origin)) throw new ApiError(400, '语音目标必须为部署管理员允许的 HTTPS 来源', 'VOICE_TARGET_FORBIDDEN');
  return url;
}

export function assertVoiceWebSocketUrl(value, allowed = voiceAllowedOrigins()) {
  let url;
  try { url = new URL(value); } catch { throw new ApiError(400, '语音 WebSocket 地址无效', 'VOICE_TARGET_FORBIDDEN'); }
  if (url.protocol !== 'wss:') throw new ApiError(400, '语音 WebSocket 必须使用 WSS', 'VOICE_TARGET_FORBIDDEN');
  const httpsUrl = new URL(url.href); httpsUrl.protocol = 'https:';
  assertVoiceUrl(httpsUrl.href, allowed);
  return url;
}
export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && (b === 168 || b === 0 || b === 2 || b === 88 && c === 99) || a === 100 && b >= 64 && b <= 127 ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  // Only global unicast IPv6; deny mapped IPv4, transition and reserved ranges.
  if (isIP(address) === 6) {
    const [first, second] = address.toLowerCase().split(':').map(value => parseInt(value || '0', 16));
    return first >= 0x2000 && first < 0x3fff && first !== 0x2002 && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
  }
  return false;
}
export async function resolveVoiceTarget(url, resolve = lookup) {
  const addresses = await resolve(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(row => !isPublicAddress(row.address))) throw new ApiError(400, '语音目标不能解析到内网或保留地址', 'VOICE_TARGET_FORBIDDEN');
  // Many deployments have IPv6 DNS records but only IPv4 outbound routing.
  return addresses.find(row => row.family === 4) || addresses[0];
}

async function abortableLookup(url, resolve, signal) {
  signal?.throwIfAborted();
  if (!signal) return resolveVoiceTarget(url, resolve);
  let abort;
  try {
    return await Promise.race([
      resolveVoiceTarget(url, resolve),
      new Promise((_, reject) => {
        abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
      })
    ]);
  } finally { signal.removeEventListener('abort', abort); }
}

export function createVoiceWebSocket({ socketFn, allowed = voiceAllowedOrigins(), resolve = lookup, WebSocketClass = WebSocket } = {}) {
  return async (value, options = {}) => {
    const url = assertVoiceWebSocketUrl(value, allowed);
    options.signal?.throwIfAborted();
    if (socketFn) return socketFn(url.href, options);
    const address = await abortableLookup(url, resolve, options.signal);
    options.signal?.throwIfAborted();
    return new WebSocketClass(url, {
      headers: options.headers, signal: options.signal, agent: false,
      followRedirects: false, perMessageDeflate: false, maxPayload: 1024 * 1024,
      lookup: (_hostname, lookupOptions, callback) => callback(null,
        lookupOptions.all ? [address] : address.address, address.family)
    });
  };
}

export function createVoiceFetch({ fetchFn, allowed = voiceAllowedOrigins(), resolve = lookup, requestFn = httpsRequest } = {}) {
  return async (value, options = {}) => {
    const url = assertVoiceUrl(value, allowed);
    // Tests can replace the entire transport. The production transport pins the
    // verified address in lookup, preserving hostname/SNI/certificate validation.
    if (fetchFn) {
      const response = await fetchFn(url.href, { ...options, redirect: 'error', credentials: 'omit' });
      if (response.status >= 300 && response.status < 400 || response.redirected) throw new ApiError(502, '语音服务不允许重定向', 'VOICE_TARGET_FORBIDDEN');
      return response;
    }
    const address = await abortableLookup(url, resolve, options.signal);
    options.signal?.throwIfAborted();
    return new Promise((resolveResponse, reject) => {
      const req = requestFn(url, { method: options.method || 'GET', headers: options.headers, signal: options.signal,
        agent: false, lookup: (_hostname, lookupOptions, callback) => callback(null,
          lookupOptions.all ? [address] : address.address, address.family) }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.destroy(); reject(new ApiError(502, '语音服务不允许重定向', 'VOICE_TARGET_FORBIDDEN')); return;
        }
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
          if ([204, 205].includes(response.statusCode)) {
            response.resume(); resolveResponse(new Response(null, { status: response.statusCode, headers }));
          } else resolveResponse(new Response(Readable.toWeb(response), { status: response.statusCode, headers }));
        } catch {
          response.destroy(); reject(new ApiError(502, '语音服务返回了无效的 HTTP 响应'));
        }
      });
      req.once('error', reject);
      req.end(options.body);
    });
  };
}

export async function readVoiceBody(response, maximum, controller) {
  if (Number(response.headers.get('content-length')) > maximum) {
    controller?.abort(); throw new ApiError(502, '语音服务响应超过大小限制', 'VOICE_RESPONSE_LIMIT');
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maximum) throw new ApiError(502, '语音服务响应超过大小限制', 'VOICE_RESPONSE_LIMIT');
    return buffer;
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.length;
      if (size > maximum) {
        controller?.abort(); await reader.cancel().catch(() => {});
        throw new ApiError(502, '语音服务响应超过大小限制', 'VOICE_RESPONSE_LIMIT');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
}
