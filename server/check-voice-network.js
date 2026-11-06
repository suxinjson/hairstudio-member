import { performance } from 'node:perf_hooks';
import { PROVIDER_DEFAULTS } from './voice.js';
import { createVoiceFetch, readVoiceBody } from './voice-network.js';

// No API keys or synthesis text are sent. HTTP errors still prove connectivity.
const targets = [
  { name: '讯飞 API', url: 'https://tts-api.xfyun.cn/v2/tts', method: 'GET' },
  { name: 'Fish Audio API', url: PROVIDER_DEFAULTS.fish_audio.apiUrl, method: 'POST', expectedStatus: 401 },
  { name: 'HeyGen API', url: PROVIDER_DEFAULTS.heygen.apiUrl, method: 'POST', expectedStatus: 401 },
  { name: 'HeyGen 音频域名', url: 'https://files.heygen.ai/', method: 'GET' }
];
const request = createVoiceFetch();
await Promise.all(targets.map(async target => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  const started = performance.now();
  try {
    const response = await request(target.url, {
      method: target.method,
      ...(target.method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
      signal: controller.signal
    });
    await readVoiceBody(response, 64 * 1024, controller);
    console.log(`${target.name}：HTTPS 可达，HTTP ${response.status}，耗时 ${Math.round(performance.now() - started)} ms${target.expectedStatus === response.status ? '（未携带密钥的预期响应）' : ''}`);
  } catch (error) {
    // Do not print upstream bodies, URLs, or environment variables.
    const code = controller.signal.aborted ? 'TIMEOUT' : String(error.code || 'NETWORK_ERROR').replace(/[^A-Z0-9_]/g, '').slice(0, 60);
    console.error(`${target.name}：连接检查失败，${code}，耗时 ${Math.round(performance.now() - started)} ms`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}));
