import { formatSpokenAmount } from './voice-text.js';

const cancelled = () => Object.assign(new Error('播放已停止'), { code: 'VOICE_CANCELLED' });
const amountVariables = new Set(['amount', 'balance', 'gift', 'totalCredit']);

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

  async queueSpeak(text, { volume = 1.0, testOptions = null, onStatus = null } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        text,
        volume,
        testOptions,
        onStatus,
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

    let objectUrl = null;
    try {
      check();
      const options = item.testOptions
        ? { text: item.text, test: true, ...item.testOptions }
        : { text: item.text };

      item.onStatus?.('synthesizing');
      const blob = await this.api.synthesizeVoice(options, { signal: controller.signal });
      check();
      objectUrl = URL.createObjectURL(blob);

      item.onStatus?.('playing');
      await this.playAudioUrl(objectUrl, item.volume);
      check();
      item.resolve();
    } catch (err) {
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

  playAudioUrl(url, volume = 1.0) {
    return new Promise((resolve, reject) => {
      const audio = new Audio();
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

      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('音频解码或播放失败'));
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

      // Max playback safety timeout (60 seconds) to avoid hanging
      timeoutTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          try { audio.pause(); } catch {}
          resolve();
        }
      }, 60000);

      audio.play().catch(err => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err.name === 'NotAllowedError') {
          reject(new Error('浏览器拦截了音频播放，请先在页面上任意点击以激活音频权限'));
        } else {
          reject(err);
        }
      });
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
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      try { item.reject(cancelled()); } catch {}
    }
  }
}

