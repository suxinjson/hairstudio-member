import { ApiError } from './security.js';
import { assertUnexposedCredential } from './exposed-credentials.js';
import { assertVoiceUrl, assertVoiceWebSocketUrl, createVoiceFetch, readVoiceBody } from './voice-network.js';
import { synthesizeXfyun } from './xfyun-voice.js';

export const DEFAULT_VOICE_CONFIG = {
  enabled: false,
  provider: 'fish_audio',
  apiUrl: '',
  apiKey: '',
  appId: '',
  model: 's2.1-pro-free',
  voiceId: '74c6aba5cbf94a15bbdc547ffce5cb38',
  volume: 1.0,
  templates: {
    consume: '{name} 消费 {amount} 元，卡内余额 {balance} 元',
    recharge: '{name} 充值 {amount} 元，卡内余额 {balance} 元'
  },
  aligenie: {
    enabled: false,
    token: '',
    actorId: '',
    authVersion: 0,
    verificationFile: 'b3e0f13ccb082b486a3c85c834b6598a.txt',
    verificationContent: 'Jfc4Z4Ur15JwUBuvUQD5wg7Nu8+l+HscqYlfofbyJdYR8lB80Mn4L/FdxiMj1Eyz',
    allowedDevices: []
  }
};

export const PROVIDER_DEFAULTS = {
  xfyun: {
    apiUrl: 'wss://tts-api.xfyun.cn/v2/tts', model: '', voiceId: 'x4_xiaoyan', appId: ''
  },
  fish_audio: {
    apiUrl: 'https://api.fish.audio/v1/tts',
    model: 's2.1-pro-free',
    voiceId: '74c6aba5cbf94a15bbdc547ffce5cb38'
  },
  heygen: {
    apiUrl: 'https://api.heygen.com/v3/models/audio/tts',
    model: 'heygen-voice-1-turbo-free',
    voiceId: '83548de556df48ba8c09c42a57c51d85'
  }
};

export const VOICE_SYNTHESIS_TIMEOUT_MS = { fish_audio: 60000, heygen: 90000, xfyun: 60000 };
export const VOICE_DOWNLOAD_TIMEOUT_MS = 30000;

export function maskApiKey(key) {
  if (!key || typeof key !== 'string') return '';
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '****';
  return trimmed.slice(0, 4) + '****' + trimmed.slice(-4);
}

export function sanitizeVoiceConfig(raw, previous = {}) {
  const config = { ...DEFAULT_VOICE_CONFIG, ...(previous || {}) };
  if (!raw || typeof raw !== 'object') return config;

  if (typeof raw.enabled === 'boolean') config.enabled = raw.enabled;

  if (Object.hasOwn(PROVIDER_DEFAULTS, raw.provider)) {
    if (raw.provider !== config.provider) {
      // A saved credential and endpoint belong to one provider only.
      Object.assign(config, PROVIDER_DEFAULTS[raw.provider], { apiKey: '', appId: '' });
    }
    config.provider = raw.provider;
  }

  if (typeof raw.apiUrl === 'string') {
    const url = raw.apiUrl.trim();
    if (!url) {
      config.apiUrl = '';
    } else {
      if (config.provider === 'xfyun') assertVoiceWebSocketUrl(url); else assertVoiceUrl(url);
      config.apiUrl = url;
    }
  }

  if (typeof raw.apiKey === 'string') {
    const key = raw.apiKey.trim();
    // Only update if not blank and not masked
    if (key && !key.includes('****')) {
      if (key.length > 256) throw new ApiError(400, 'API Key 长度不能超过 256 个字符');
      assertUnexposedCredential(key);
      config.apiKey = key;
    }
  }
  if (raw.clearApiKey === true) {
    config.apiKey = '';
  }

  if (typeof raw.appId === 'string') {
    const appId = raw.appId.trim();
    if (appId && !/^[a-zA-Z0-9]{1,64}$/.test(appId)) throw new ApiError(400, '讯飞 APPID 格式无效');
    config.appId = appId;
  }

  if (typeof raw.model === 'string') {
    config.model = raw.model.trim().slice(0, 100);
  }

  if (typeof raw.voiceId === 'string') {
    config.voiceId = raw.voiceId.trim().slice(0, 100);
  }

  if (typeof raw.volume === 'number' && Number.isFinite(raw.volume)) {
    config.volume = Math.max(0.1, Math.min(1.0, raw.volume));
  }

  if (raw.templates && typeof raw.templates === 'object') {
    config.templates = {
      consume: typeof raw.templates.consume === 'string'
        ? raw.templates.consume.trim().slice(0, 200)
        : (config.templates?.consume || DEFAULT_VOICE_CONFIG.templates.consume),
      recharge: typeof raw.templates.recharge === 'string'
        ? raw.templates.recharge.trim().slice(0, 200)
        : (config.templates?.recharge || DEFAULT_VOICE_CONFIG.templates.recharge)
    };
  }

  if (raw.aligenie && typeof raw.aligenie === 'object') {
    const prevAli = config.aligenie || DEFAULT_VOICE_CONFIG.aligenie;
    config.aligenie = {
      authVersion: typeof raw.aligenie.token === 'string' && raw.aligenie.token.trim() ? 2 : (prevAli.authVersion || 0),
      enabled: typeof raw.aligenie.enabled === 'boolean' ? raw.aligenie.enabled : prevAli.enabled,
      token: typeof raw.aligenie.token === 'string' && raw.aligenie.token.trim() ? raw.aligenie.token.trim() : prevAli.token,
      actorId: typeof raw.aligenie.actorId === 'string' ? raw.aligenie.actorId.trim() : (prevAli.actorId || ''),
      verificationFile: typeof raw.aligenie.verificationFile === 'string' ? raw.aligenie.verificationFile.trim().slice(0, 100) : prevAli.verificationFile,
      verificationContent: typeof raw.aligenie.verificationContent === 'string' ? raw.aligenie.verificationContent.trim().slice(0, 200) : prevAli.verificationContent,
      allowedDevices: Array.isArray(raw.aligenie.allowedDevices)
        ? raw.aligenie.allowedDevices.map(d => String(d).trim()).filter(Boolean).slice(0, 50)
        : (prevAli.allowedDevices || [])
    };
    if (Array.isArray(raw.aligenie.allowedDevices) && (raw.aligenie.allowedDevices.length > 50 || raw.aligenie.allowedDevices.some(d => typeof d !== 'string' || !d.trim() || d.length > 128))) throw new ApiError(400, '设备白名单最多 50 个，每个标识为 1–128 位文本');
    if (raw.aligenie.clearToken === true) config.aligenie.token = '';
    if (config.aligenie.token && (config.aligenie.token.length < 32 || config.aligenie.token.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(config.aligenie.token))) throw new ApiError(400, '语音签名密钥须为 32–100 位随机字符');
    if (config.aligenie.actorId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(config.aligenie.actorId)) throw new ApiError(400, '语音记账账号标识无效');
  }

  return config;
}

// Existing unsafe settings remain readable for repair, but cannot be used.
export function readVoiceConfig(saved = {}) {
  const safe = { ...saved, apiKey: saved.apiKey || '', aligenie: { ...DEFAULT_VOICE_CONFIG.aligenie, ...saved.aligenie } };
  try { assertUnexposedCredential(safe.apiKey); } catch { safe.apiKey = ''; safe.enabled = false; }
  try { if (safe.apiUrl) { if (safe.provider === 'xfyun') assertVoiceWebSocketUrl(safe.apiUrl); else assertVoiceUrl(safe.apiUrl); } } catch { safe.apiUrl = ''; safe.enabled = false; }
  if (safe.aligenie.authVersion !== 2 || !/^[a-zA-Z0-9_-]{32,100}$/.test(safe.aligenie.token || '')) {
    safe.aligenie.enabled = false; safe.aligenie.token = ''; safe.aligenie.authVersion = 0;
  }
  return { ...DEFAULT_VOICE_CONFIG, ...PROVIDER_DEFAULTS[safe.provider || DEFAULT_VOICE_CONFIG.provider], ...safe };
}

async function voiceOperation(provider, stage, timeoutMs, operation) {
  const label = { heygen: 'HeyGen', fish_audio: 'Fish Audio', xfyun: '讯飞' }[provider];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (controller.signal.aborted || err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new ApiError(504, `${label} ${stage}超时（${timeoutMs / 1000} 秒），请稍后重试并检查服务器出站网络`, 'VOICE_UPSTREAM_TIMEOUT');
    }
    const code = err.code || err.cause?.code;
    const detail = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code) ? `（${code}）` : '';
    throw new ApiError(502, `${label} ${stage}失败${detail}，请检查服务器出站 HTTPS 网络或接口响应`, 'VOICE_UPSTREAM_FAILED');
  } finally {
    clearTimeout(timer);
  }
}

async function assertVoiceResponse(response, label, controller) {
  if (response.ok) return;
  // Consume a bounded error body without exposing credentials or upstream URLs.
  try { await readVoiceBody(response, 8192, controller); } catch {}
  const hints = {
    400: '请检查模型、音色 ID 和请求参数',
    401: 'API Key 无效或已失效，请重新配置当前服务商的密钥',
    403: 'API Key 无权访问此接口或音色',
    402: '当前模型额度不足，请检查 API 余额',
    404: '请检查接口地址和音色 ID',
    429: '请求过于频繁或免费模型繁忙，请稍后重试'
  };
  throw new ApiError(502, `${label} 接口错误 (${response.status})：${hints[response.status] || '上游服务暂时不可用，请稍后重试'}`, 'VOICE_UPSTREAM_ERROR');
}

export function publicVoiceConfig(config, role) {
  const { enabled, provider, model, voiceId, volume, templates } = config;
  const result = { enabled, provider, model, voiceId, volume, templates, apiKey: '', hasApiKey: Boolean(config.apiKey || provider === 'xfyun' && process.env.XFYUN_API_PASSWORD) };
  if (role === 'owner') Object.assign(result, { apiUrl: config.apiUrl, appId: config.appId || process.env.XFYUN_APP_ID || '',
    serverXfyunConfigured: Boolean(process.env.XFYUN_APP_ID && process.env.XFYUN_API_PASSWORD), aligenie: {
    enabled: config.aligenie.enabled, actorId: config.aligenie.actorId, authVersion: config.aligenie.authVersion,
    allowedDevices: config.aligenie.allowedDevices, hasToken: Boolean(config.aligenie.token),
    verificationFile: config.aligenie.verificationFile, verificationContent: config.aligenie.verificationContent
  } });
  return result;
}

export async function synthesizeTTS({
  provider = 'fish_audio',
  apiUrl = '',
  apiKey = '',
  appId = '',
  model = '',
  voiceId = '',
  text = '',
  fetchFn,
  socketFn
}) {
  if (!text || typeof text !== 'string') throw new ApiError(400, '播报文本不能为空');
  const trimmedText = text.trim();
  if (trimmedText.length === 0 || trimmedText.length > 300) {
    throw new ApiError(400, '播报文本长度必须在 1 至 300 字之间');
  }
  if (provider === 'xfyun') {
    apiKey = apiKey || process.env.XFYUN_API_PASSWORD || '';
    appId = appId || process.env.XFYUN_APP_ID || '';
  }
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new ApiError(400, '未配置语音合成 API Key');
  }

  const cleanKey = apiKey.trim();
  assertUnexposedCredential(cleanKey);
  const request = createVoiceFetch({ fetchFn });

  if (provider === 'xfyun') {
    if (typeof appId !== 'string' || !/^[a-zA-Z0-9]{1,64}$/.test(appId.trim())) throw new ApiError(400, '请配置讯飞 APPID');
    return voiceOperation(provider, '语音合成', VOICE_SYNTHESIS_TIMEOUT_MS.xfyun, controller => synthesizeXfyun({
      apiUrl: apiUrl?.trim() || PROVIDER_DEFAULTS.xfyun.apiUrl, apiKey: cleanKey,
      appId: appId.trim(), voiceId: voiceId?.trim() || PROVIDER_DEFAULTS.xfyun.voiceId,
      text: trimmedText, signal: controller.signal, socketFn
    }));
  } else if (provider === 'fish_audio') {
    const endpoint = apiUrl?.trim() || PROVIDER_DEFAULTS.fish_audio.apiUrl;
    const targetModel = model?.trim() || PROVIDER_DEFAULTS.fish_audio.model;
    const targetRefId = voiceId?.trim() || PROVIDER_DEFAULTS.fish_audio.voiceId;

    return voiceOperation(provider, '语音合成', VOICE_SYNTHESIS_TIMEOUT_MS[provider], async controller => {
      const response = await request(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cleanKey}`,
          'Content-Type': 'application/json',
          'model': targetModel
        },
        body: JSON.stringify({
          text: trimmedText,
          reference_id: targetRefId,
          format: 'mp3'
        }),
        signal: controller.signal
      });

      await assertVoiceResponse(response, 'Fish Audio', controller);

      const contentType = response.headers.get('content-type') || 'audio/mpeg';
      const buffer = await readVoiceBody(response, 8 * 1024 * 1024, controller);
      if (!buffer.length || !/^audio\//i.test(contentType)) throw new ApiError(502, '语音服务未返回音频');
      return { buffer, contentType };
    });
  } else if (provider === 'heygen') {
    const endpoint = apiUrl?.trim() || PROVIDER_DEFAULTS.heygen.apiUrl;
    const targetModel = model?.trim() || PROVIDER_DEFAULTS.heygen.model;
    const targetVoiceId = voiceId?.trim() || PROVIDER_DEFAULTS.heygen.voiceId;

    const audioUrl = await voiceOperation(provider, '语音合成', VOICE_SYNTHESIS_TIMEOUT_MS[provider], async controller => {
      const response = await request(endpoint, {
        method: 'POST',
        headers: {
          'X-Api-Key': cleanKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: targetModel,
          voice_id: targetVoiceId,
          text: trimmedText,
          language: 'zh',
          expressiveness_boost: 0.8
        }),
        signal: controller.signal
      });

      await assertVoiceResponse(response, 'HeyGen', controller);

      const data = JSON.parse((await readVoiceBody(response, 64 * 1024, controller)).toString('utf8'));
      const audioUrl = data?.data?.audio_url || data?.data?.url;
      if (typeof audioUrl !== 'string' || !audioUrl) throw new ApiError(502, 'HeyGen 未返回有效的音频地址');
      return audioUrl;
    });

    return voiceOperation(provider, '音频下载', VOICE_DOWNLOAD_TIMEOUT_MS, async controller => {
      const audioRes = await request(audioUrl, { signal: controller.signal });
      if (!audioRes.ok) throw new ApiError(502, `获取 HeyGen 音频文件失败 (${audioRes.status})`);

      const contentType = audioRes.headers.get('content-type') || 'audio/wav';
      const buffer = await readVoiceBody(audioRes, 8 * 1024 * 1024, controller);
      if (!buffer.length || !/^audio\//i.test(contentType)) throw new ApiError(502, '语音服务未返回音频');
      return { buffer, contentType };
    });
  } else {
    throw new ApiError(400, `不支持的语音服务商: ${provider}`);
  }
}
