import { formatSpokenAmount } from './voice-text.js';

const cancelled = () => Object.assign(new Error('播放已停止'), { code: 'VOICE_CANCELLED' });
const amountVariables = new Set(['amount', 'balance', 'gift', 'totalCredit']);
// A valid, silent WAV unlocks the same media element used after synthesis.
const SILENT_AUDIO = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';
export const VOICE_PLAYBACK_START_TIMEOUT_MS = 15000;
export const VOICE_PLAYBACK_TIMEOUT_MS = 180000;

export class VoicePlayer {
  constructor({ api, context = () => '', canBroadcast = () => true } = {}) {
    this.api = api;
    this.context = context;
    this.canBroadcast = canBroadcast;
    this.version = 0;
    this.queue = [];
    this.isPlaying = false;
    this.cachedConfig = null;
    this.lastConfigFetch = 0;
    this.currentAudio = null;
    this.currentItem = null;
    this.currentRequest = null;
    this.cachedContext = null;
    this.audioElement = null;
  }

  getAudioElement() {
    return this.audioElement ||= new Audio();
  }

  preparePlayback() {
    if (this.isPlaying) return;
    try {
      const audio = this.getAudioElement();
      audio.preload = 'auto';
      audio.src = SILENT_AUDIO;
      // This must run synchronously inside the user's click handler.
      Promise.resolve(audio.play()).catch(() => {});
    } catch {}
  }

  async getConfig(forceRefresh = false) {
    const now = Date.now();
    const context = this.context(), version = this.version;
    if (!forceRefresh && this.cachedConfig && this.cachedContext === context && (now - this.lastConfigFetch < 30000)) {
      return this.cachedConfig;
    }
    const config = await this.api.getVoiceConfig();
    if (context !== this.context() || version !== this.version) throw cancelled();
    this.cachedConfig = config;
    this.cachedContext = context;
    this.lastConfigFetch = now;
    return config;
  }

  invalidateConfig() {
    this.cachedConfig = null;
    this.lastConfigFetch = 0;
    this.cachedContext = null;
  }

  formatTemplate(template, vars = {}) {
    if (!template) return '';
    return template.replace(/\{(\w+)\}/g, (match, key) => {
      if (vars[key] !== undefined && vars[key] !== null) {
        return amountVariables.has(key) ? formatSpokenAmount(vars[key]) : String(vars[key]);
      }
      return match;
    });
  }

  async broadcast(type, params = {}, { onError = error => console.warn('语音播报失败:', error.message) } = {}) {
    if (!this.canBroadcast()) return false;
    const version = this.version;
    try {
      const config = await this.getConfig();
      if (version !== this.version || !this.canBroadcast()) throw cancelled();
      if (!config || !config.enabled) return false;
      if (config.events?.[type] === false) return false;

      const template = config.templates?.[type];
      if (!template) return;

      const text = this.formatTemplate(template, {
        store: config.storeName || '我的门店',
        ...params
      });

      if (!text || !text.trim()) return;

      const volume = typeof config.volume === 'number' ? config.volume : 1.0;
      await this.queueSpeak(text, { volume });
      return true;
    } catch (err) {
      if (err.code !== 'VOICE_CANCELLED') onError(err);
      return false;
    }
  }

  async queueSpeak(text, { volume = 1.0, testOptions = null, onStatus = null, audioBlob = null } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        text,
        volume,
        testOptions,
        onStatus,
        audioBlob,
        resolve,
        reject,
        context: this.context(), version: this.version
      });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.isPlaying || this.queue.length === 0) return;
    this.isPlaying = true;
    const item = this.queue.shift();
    this.currentItem = item;
    const controller = new AbortController();
    this.currentRequest = controller;
    const check = () => {
      if (item.version !== this.version || item.context !== this.context()) throw cancelled();
    };

    let objectUrl = null, blob = null;
    try {
      check();
      const options = item.testOptions
        ? { text: item.text, test: true, ...item.testOptions }
        : { text: item.text };

      if (!item.audioBlob) item.onStatus?.('synthesizing');
      // A blocked preview retries its existing audio directly in the click event.
      blob = item.audioBlob || await this.api.synthesizeVoice(options, { signal: controller.signal });
      check();
      objectUrl = URL.createObjectURL(blob);

      await this.playAudioUrl(objectUrl, item.volume, () => item.onStatus?.('playing'));
      check();
      item.resolve();
    } catch (err) {
      if (err.code === 'VOICE_PLAYBACK_BLOCKED' && blob && item.onStatus) {
        err.retryPlayback = ({ onStatus = item.onStatus } = {}) => {
          try { check(); } catch (error) { return Promise.reject(error); }
          return this.queueSpeak(item.text, { volume: item.volume, testOptions: item.testOptions, onStatus, audioBlob: blob });
        };
      }
      item.reject(err);
    } finally {
      if (objectUrl) {
        try { URL.revokeObjectURL(objectUrl); } catch {}
      }
      this.isPlaying = false;
      this.currentItem = null;
      this.currentRequest = null;
      // Small pause between multiple queued announcements
      setTimeout(() => this.processQueue(), 300);
    }
  }

  playAudioUrl(url, volume = 1.0, onPlaying = null) {
    return new Promise((resolve, reject) => {
      const audio = this.getAudioElement();
      this.currentAudio = audio;
      audio.volume = Math.max(0, Math.min(1, volume));
      audio.preload = 'auto';
      audio.src = url;

      let settled = false;
      let timeoutTimer = null;

      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('error', onError);
        audio.removeEventListener('playing', onStarted);
        try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch {}
        if (this.currentAudio === audio) this.currentAudio = null;
        this.stopCurrent = null;
      };

      const onEnded = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const fail = error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onError = () => fail(Object.assign(new Error('音频解码或播放失败'), { code: 'VOICE_PLAYBACK_FAILED' }));
      const onStarted = () => {
        if (settled) return;
        clearTimeout(timeoutTimer);
        timeoutTimer = setTimeout(() => fail(Object.assign(new Error('音频播放超时，请重试'), { code: 'VOICE_PLAYBACK_TIMEOUT' })), VOICE_PLAYBACK_TIMEOUT_MS);
        onPlaying?.();
      };

      this.stopCurrent = () => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch {}
        resolve();
      };

      audio.addEventListener('ended', onEnded);
      audio.addEventListener('error', onError);
      audio.addEventListener('playing', onStarted, { once: true });

      timeoutTimer = setTimeout(() => fail(Object.assign(new Error('音频未能开始播放，请重试并检查设备声音权限'), { code: 'VOICE_PLAYBACK_TIMEOUT' })), VOICE_PLAYBACK_START_TIMEOUT_MS);

      const playFailed = err => {
        if (err.name === 'NotAllowedError') {
          fail(Object.assign(new Error('音频已合成，浏览器阻止了自动播放，请在语音设置中点击试听以激活声音'), { code: 'VOICE_PLAYBACK_BLOCKED' }));
        } else {
          fail(err);
        }
      };
      try { Promise.resolve(audio.play()).catch(playFailed); } catch (err) { playFailed(err); }
    });
  }

  stop() {
    this.version++;
    this.invalidateConfig();
    this.currentRequest?.abort();
    this.currentItem?.reject(cancelled());
    if (typeof this.stopCurrent === 'function') {
      try { this.stopCurrent(); } catch {}
      this.stopCurrent = null;
    } else if (this.currentAudio) {
      try {
        this.currentAudio.pause();
        this.currentAudio.currentTime = 0;
      } catch {}
      this.currentAudio = null;
    }
    if (this.audioElement) {
      try { this.audioElement.pause(); this.audioElement.removeAttribute('src'); this.audioElement.load(); } catch {}
      // Keep the user's activated element for later transaction announcements.
    }
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      try { item.reject(cancelled()); } catch {}
    }
  }
}

