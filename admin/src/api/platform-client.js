const KEY = 'member_platform_session_v1';
export class PlatformClient {
  constructor({ fetch: fetcher = (...args) => fetch(...args), storage = globalThis.sessionStorage } = {}) {
    this.fetcher = fetcher; this.storage = storage; this.token = ''; this.expiresAt = ''; this.generation = 0;
    try { const saved = JSON.parse(storage?.getItem(KEY) || 'null'); if (Date.parse(saved?.expiresAt) > Date.now() && /^[A-Za-z0-9_-]{43}$/.test(saved.token || '')) { this.token = saved.token; this.expiresAt = saved.expiresAt; } } catch {}
  }
  clear() { this.generation++; this.token = ''; this.expiresAt = ''; this.storage?.removeItem(KEY); }
  async request(path, input, method = input === undefined ? 'GET' : 'POST') {
    const generation = this.generation;
    if (this.token && Date.parse(this.expiresAt) <= Date.now()) { this.clear(); throw Object.assign(new Error('平台登录已过期，请重新登录'), { status: 401 }); }
    const response = await this.fetcher('/api/platform/v1' + path, { method, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
      headers: { ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const value = await response.json();
    if (generation !== this.generation) throw Object.assign(new Error('平台登录状态已变化'), { status: 401 });
    if (!response.ok) { if (response.status === 401) this.clear(); throw Object.assign(new Error(value.error || '平台请求失败'), { status: response.status, code: value.code, requestId: response.headers.get('X-Request-Id') }); }
    return value;
  }
  async login(username, password) {
    this.clear(); const result = await this.request('/auth/login', { username, password });
    this.token = result.accessToken; this.expiresAt = result.expiresAt;
    this.storage?.setItem(KEY, JSON.stringify({ token: this.token, expiresAt: this.expiresAt })); return result.user;
  }
  async logout() { try { if (this.token) await this.request('/auth/logout', {}); } finally { this.clear(); } }
}
