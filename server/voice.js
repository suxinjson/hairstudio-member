import { ApiError } from './security.js';

export const DEFAULT_VOICE_CONFIG = {
  enabled: false,
  provider: 'fish_audio',
  apiUrl: '',
  apiKey: '',
  model: 's2.1-pro-free',
  voiceId: '74c6aba5cbf94a15bbdc547ffce5cb38',
  volume: 1.0,
  templates: {
    consume: '{name} 消费 {amount} 元，卡内余额 {balance} 元',
    recharge: '{name} 充值 {amount} 元，卡内余额 {balance} 元'
  },
  aligenie: {
    enabled: true,
    token: '',
    verificationFile: '',
    verificationContent: '',
    allowedDevices: []
  }
};

export const PROVIDER_DEFAULTS = {
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

  if (['fish_audio', 'heygen'].includes(raw.provider)) {
    config.provider = raw.provider;
  }

  if (typeof raw.apiUrl === 'string') {
    const url = raw.apiUrl.trim();
    if (!url) {
      config.apiUrl = '';
    } else {
      if (!/^https?:\/\/[^\s]+$/.test(url)) throw new ApiError(400, 'API 地址必须以 http:// 或 https:// 开头');
      config.apiUrl = url;
    }
  }

  if (typeof raw.apiKey === 'string') {
    const key = raw.apiKey.trim();
    // Only update if not blank and not masked
    if (key && !key.includes('****')) {
      if (key.length > 256) throw new ApiError(400, 'API Key 长度不能超过 256 个字符');
      config.apiKey = key;
    }
  }
  if (raw.clearApiKey === true) {
    config.apiKey = '';
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
      enabled: typeof raw.aligenie.enabled === 'boolean' ? raw.aligenie.enabled : prevAli.enabled,
      token: typeof raw.aligenie.token === 'string' ? raw.aligenie.token.trim().slice(0, 100) : prevAli.token,
      verificationFile: typeof raw.aligenie.verificationFile === 'string' ? raw.aligenie.verificationFile.trim().slice(0, 100) : prevAli.verificationFile,
      verificationContent: typeof raw.aligenie.verificationContent === 'string' ? raw.aligenie.verificationContent.trim().slice(0, 200) : prevAli.verificationContent,
      allowedDevices: Array.isArray(raw.aligenie.allowedDevices)
        ? raw.aligenie.allowedDevices.map(d => String(d).trim()).filter(Boolean).slice(0, 50)
        : (prevAli.allowedDevices || [])
    };
  }

  return config;
}

export async function synthesizeTTS({
  provider = 'fish_audio',
  apiUrl = '',
  apiKey = '',
  model = '',
  voiceId = '',
  text = '',
  fetchFn = fetch
}) {
  if (!text || typeof text !== 'string') throw new ApiError(400, '播报文本不能为空');
  const trimmedText = text.trim();
  if (trimmedText.length === 0 || trimmedText.length > 300) {
    throw new ApiError(400, '播报文本长度必须在 1 至 300 字之间');
  }
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new ApiError(400, '未配置语音合成 API Key');
  }

  const cleanKey = apiKey.trim();

  if (provider === 'fish_audio') {
    const endpoint = apiUrl?.trim() || PROVIDER_DEFAULTS.fish_audio.apiUrl;
    const targetModel = model?.trim() || PROVIDER_DEFAULTS.fish_audio.model;
    const targetRefId = voiceId?.trim() || PROVIDER_DEFAULTS.fish_audio.voiceId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetchFn(endpoint, {
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

      if (!response.ok) {
        let errMessage = 'Fish Audio 合成失败';
        try {
          const errJson = await response.json();
          errMessage = errJson.message || errJson.error || errMessage;
        } catch {
          try { errMessage = await response.text(); } catch {}
        }
        throw new ApiError(502, `Fish Audio 接口错误 (${response.status}): ${errMessage}`);
      }

      const contentType = response.headers.get('content-type') || 'audio/mpeg';
      const arrayBuffer = await response.arrayBuffer();
      return { buffer: Buffer.from(arrayBuffer), contentType };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err.name === 'AbortError') throw new ApiError(504, 'Fish Audio 请求超时');
      throw new ApiError(502, `Fish Audio 请求失败: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  } else if (provider === 'heygen') {
    const endpoint = apiUrl?.trim() || PROVIDER_DEFAULTS.heygen.apiUrl;
    const targetModel = model?.trim() || PROVIDER_DEFAULTS.heygen.model;
    const targetVoiceId = voiceId?.trim() || PROVIDER_DEFAULTS.heygen.voiceId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetchFn(endpoint, {
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

      if (!response.ok) {
        let errMessage = 'HeyGen 合成失败';
        try {
          const errJson = await response.json();
          errMessage = errJson.error?.message || errJson.message || errMessage;
        } catch {
          try { errMessage = await response.text(); } catch {}
        }
        throw new ApiError(502, `HeyGen 接口错误 (${response.status}): ${errMessage}`);
      }

      const data = await response.json();
      const audioUrl = data?.data?.audio_url || data?.data?.url;
      if (!audioUrl) throw new ApiError(502, 'HeyGen 未返回有效的音频地址');

      const audioRes = await fetchFn(audioUrl, { signal: controller.signal });
      if (!audioRes.ok) throw new ApiError(502, `获取 HeyGen 音频文件失败 (${audioRes.status})`);

      const contentType = audioRes.headers.get('content-type') || 'audio/wav';
      const arrayBuffer = await audioRes.arrayBuffer();
      return { buffer: Buffer.from(arrayBuffer), contentType };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err.name === 'AbortError') throw new ApiError(504, 'HeyGen 请求超时');
      throw new ApiError(502, `HeyGen 请求失败: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  } else {
    throw new ApiError(400, `不支持的语音服务商: ${provider}`);
  }
}
