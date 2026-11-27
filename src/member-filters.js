// 头部与独立会员列表共用范围，避免入口之间遗漏筛选项。
export const MEMBER_FILTERS = [
  { value: 'all', label: '全部会员', description: '查看完整会员名单' },
  { value: 'recent', label: '最近消费', description: '按消费时间，显示最近 12 位会员' },
  { value: 'low', label: '低余额', description: '可用余额 0–50 元（含零余额）' },
  { value: 'debt', label: '欠款会员', description: '查看待还款会员' },
  { value: 'archived', label: '已归档会员', description: '保留历史，退出在用名单' }
];
