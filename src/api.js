// 移动端轻量 API 客户端封装
const BASE_URL = '/api';

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  try {
    const res = await fetch(url, { ...options, headers });
    const json = await res.json();
    if (!res.ok || json.code !== 0) {
      throw new Error(json.message || '请求失败，请稍后重试');
    }
    return json.data;
  } catch (err) {
    console.error(`API Error [${path}]:`, err);
    throw err;
  }
}

export const api = {
  // 首页看板
  getDashboard() {
    return request('/dashboard');
  },

  // 会员列表/搜索
  getMembers(query = '') {
    const q = query ? `?query=${encodeURIComponent(query)}` : '';
    return request(`/members${q}`);
  },

  // 获取单个会员详情（包含流水）
  getMemberDetail(id) {
    return request(`/members/${id}`);
  },

  // 新建会员
  createMember(data) {
    return request('/members', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  // 更新会员
  updateMember(id, data) {
    return request(`/members/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  },

  // 充值
  recharge(memberId, data) {
    return request(`/members/${memberId}/recharge`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  // 消费扣款
  consume(memberId, data) {
    return request(`/members/${memberId}/consume`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  // 全局流水账本
  getLedgers(params = {}) {
    const queryStr = new URLSearchParams(params).toString();
    return request(`/ledgers${queryStr ? '?' + queryStr : ''}`);
  },

  // 系统网络信息（手机扫码/局域网IP）
  getNetworkInfo() {
    return request('/system/network');
  }
};
