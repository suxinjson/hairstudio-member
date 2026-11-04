import { ref } from 'vue';

const STORAGE_KEY = 'hairstudio_admin_auth';

export class AdminApiClient {
  constructor() {
    this.accessToken = ref('');
    this.refreshToken = ref('');
    this.user = ref(null);
    this.deviceId = this.getOrCreateDeviceId();
    this.isLocked = ref(false);

    this.restoreSession();
  }

  getOrCreateDeviceId() {
    let id = localStorage.getItem('hairstudio_device_id');
    if (!id) {
      id = 'pc-admin-' + Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('hairstudio_device_id', id);
    }
    return id;
  }

  restoreSession() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        this.accessToken.value = parsed.accessToken || '';
        this.refreshToken.value = parsed.refreshToken || '';
        this.user.value = parsed.user || null;
      }
    } catch {
      this.clearSession();
    }
  }

  saveSession(data) {
    this.accessToken.value = data.accessToken;
    this.refreshToken.value = data.refreshToken;
    this.user.value = data.user;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      user: data.user
    }));
  }

  clearSession() {
    this.accessToken.value = '';
    this.refreshToken.value = '';
    this.user.value = null;
    this.isLocked.value = false;
    localStorage.removeItem(STORAGE_KEY);
  }

  async request(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };

    if (this.accessToken.value) {
      headers['Authorization'] = `Bearer ${this.accessToken.value}`;
    }

    let response = await fetch(path, {
      ...options,
      headers
    });

    // 若 AccessToken 过期 (401)，尝试自动使用 RefreshToken 换取新令牌
    if (response.status === 401 && this.refreshToken.value && !options._isRetry) {
      const refreshed = await this.refresh();
      if (refreshed) {
        headers['Authorization'] = `Bearer ${this.accessToken.value}`;
        response = await fetch(path, {
          ...options,
          headers,
          _isRetry: true
        });
      } else {
        this.clearSession();
        throw new Error('登录会话已过期，请重新登录');
      }
    }

    const resData = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errorMsg = resData.error || `请求失败 (${response.status})`;
      const error = new Error(errorMsg);
      error.status = response.status;
      error.code = resData.code;
      throw error;
    }

    return resData;
  }

  async login(username, password) {
    const data = await this.request('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username,
        password,
        deviceId: this.deviceId
      })
    });

    this.saveSession(data);
    this.isLocked.value = false;
    return data;
  }

  async refresh() {
    try {
      const data = await this.request('/api/v1/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({
          refreshToken: this.refreshToken.value
        })
      });
      this.saveSession(data);
      return true;
    } catch {
      this.clearSession();
      return false;
    }
  }

  async logout() {
    try {
      if (this.accessToken.value) {
        await this.request('/api/v1/auth/logout', { method: 'POST' });
      }
    } finally {
      this.clearSession();
    }
  }

  async getAccount() {
    return this.request('/api/v1/account');
  }

  async sync(operations) {
    return this.request('/api/v1/sync', {
      method: 'POST',
      body: JSON.stringify({ operations })
    });
  }

  async getUsers() {
    return this.request('/api/v1/users');
  }

  async createUser(payload) {
    return this.request('/api/v1/users', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  async updateUser(id, payload) {
    return this.request(`/api/v1/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
  }

  async getActivity() {
    return this.request('/api/v1/activity');
  }

  /**
   * 提交批量导入任务至云端
   * 将解析出的会员记录，转为标准的同步操作流水并原子入库
   */
  async executeBatchImport(validItems, strategy, onProgress = () => {}) {
    if (!validItems.length) return { success: true, count: 0 };

    const BATCH_CHUNK = 50; // 每批 50 条操作，防止单次请求超时
    let totalImported = 0;

    for (let chunkIdx = 0; chunkIdx < validItems.length; chunkIdx += BATCH_CHUNK) {
      const chunk = validItems.slice(chunkIdx, chunkIdx + BATCH_CHUNK);
      const operations = [];

      for (const item of chunk) {
        const opId = 'op-imp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
        const now = new Date().toISOString();

        if (item.status === 'valid_new') {
          // 新建会员
          operations.push({
            id: opId,
            method: 'createMember',
            args: [{
              name: item.data.name,
              phone: item.data.phone,
              initialBalance: item.data.balanceCents,
              giftBalance: item.data.giftCents,
              remark: item.data.remark || '',
              tag: item.data.tag || ''
            }],
            actorId: this.user.value?.id,
            deviceId: this.deviceId,
            generated: { ids: [opId], times: [now] }
          });
        } else if (item.status === 'conflict') {
          if (strategy === 'merge_balance' && (item.data.balanceCents > 0 || item.data.giftCents > 0)) {
            // 累加余额：记一笔期初导入充值流水
            operations.push({
              id: opId,
              method: 'recharge',
              args: [{
                memberId: item.existingMember.id,
                amount: item.data.balanceCents,
                gift: item.data.giftCents || 0,
                channel: '期初导入',
                remark: `批量导入累加余额 (${item.data.remark || '无备注'})`
              }],
              actorId: this.user.value?.id,
              deviceId: this.deviceId,
              generated: { ids: [opId], times: [now] }
            });
          } else if (strategy === 'overwrite_profile') {
            // 覆盖资料：更新会员基本信息
            operations.push({
              id: opId,
              method: 'updateMember',
              args: [{
                id: item.existingMember.id,
                name: item.data.name,
                phone: item.data.phone,
                remark: item.data.remark || item.existingMember.remark || '',
                tag: item.data.tag || item.existingMember.tag || ''
              }],
              actorId: this.user.value?.id,
              deviceId: this.deviceId,
              generated: { ids: [opId], times: [now] }
            });
          }
          // strategy === 'skip' 则忽略不做任何操作
        }
      }

      if (operations.length > 0) {
        await this.sync(operations);
        totalImported += operations.length;
      }

      onProgress(Math.min(100, Math.round(((chunkIdx + chunk.length) / validItems.length) * 100)));
    }

    return {
      success: true,
      count: totalImported
    };
  }
}

export const adminApi = new AdminApiClient();
