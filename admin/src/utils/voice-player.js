import { adminApi } from '../api/client.js';

class VoicePlayer {
  constructor() {
    this.queue = [];
    this.isPlaying = false;
    this.cachedConfig = null;
    this.lastConfigFetch = 0;
    this.currentAudio = null;
  }

  async getConfig(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.cachedConfig && (now - this.lastConfigFetch < 30000)) {
      return this.cachedConfig;
    }
    try {
      this.cachedConfig = await adminApi.getVoiceConfig();
      this.lastConfigFetch = now;
      return this.cachedConfig;
    } catch (err) {
      return this.cachedConfig || { enabled: false };
    }
  }

  invalidateConfig() {
    this.cachedConfig = null;
    this.lastConfigFetch = 0;
  }

  formatTemplate(template, vars = {}) {
    if (!template) return '';
    return template.replace(/\{(\w+)\}/g, (match, key) => {
      if (vars[key] !== undefined && vars[key] !== null) {
        return String(vars[key]);
      }
      return match;
    });
  }

  async broadcast(type, params = {}) {
    try {
      const config = await this.getConfig();
      if (!config || !config.enabled) return;

      const template = config.templates?.[type];
      if (!template) return;

      const text = this.formatTemplate(template, {
        store: '梦飞空间',
        ...params
      });

      if (!text || !text.trim()) return;

      const volume = typeof config.volume === 'number' ? config.volume : 1.0;
      await this.queueSpeak(text, { volume });
    } catch (err) {
      console.warn('语音播报失败:', err.message);
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
        reject
      });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.isPlaying || this.queue.length === 0) return;
    this.isPlaying = true;
    const item = this.queue.shift();

    let objectUrl = null;
    try {
      const options = item.testOptions
        ? { text: item.text, test: true, ...item.testOptions }
        : { text: item.text };

      item.onStatus?.('synthesizing');
      const blob = await adminApi.synthesizeVoice(options);
      objectUrl = URL.createObjectURL(blob);

      item.onStatus?.('playing');
      await this.playAudioUrl(objectUrl, item.volume);
      item.resolve();
    } catch (err) {
      item.reject(err);
    } finally {
      if (objectUrl) {
        try { URL.revokeObjectURL(objectUrl); } catch {}
      }
      this.isPlaying = false;
      // Small pause between multiple queued announcements
      setTimeout(() => this.processQueue(), 300);
    }
  }

  playAudioUrl(url, volume = 1.0) {
    return new Promise((resolve, reject) => {
      const audio = new Audio();
      this.currentAudio = audio;
      audio.volume = Math.max(0, Math.min(1, volume));
      audio.src = url;

      let settled = false;
      let timeoutTimer = null;

      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('error', onError);
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
      try { item.reject(new Error('播放已停止')); } catch {}
    }
    this.isPlaying = false;
  }
}

export const voicePlayer = new VoicePlayer();
