export function normalizeServerUrl(value) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw new Error('请填写完整服务器地址'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('请填写服务器域名，例如 https://member.example.com');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('云端连接必须使用 HTTPS');
  return url.origin;
}
