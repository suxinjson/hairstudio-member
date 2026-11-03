<template>
  <section class="customers-page" aria-label="客户列表">
    <div class="customer-filters" aria-label="客户范围">
      <button v-for="item in filters" :key="item.value" type="button" :aria-pressed="filter === item.value"
        @click="$emit('update:filter', item.value)">{{ item.label }}</button>
    </div>
    <button v-if="summary.totalDebt > 0" type="button" class="customer-debt-summary" @click="$emit('update:filter', 'debt')">
      <CircleAlert :size="21" aria-hidden="true" />
      <span><strong>{{ summary.debtMemberCount }} 位客户尚有欠款</strong><span>待收回 ¥{{ format(summary.totalDebt) }}</span></span>
      <ChevronRight :size="18" aria-hidden="true" />
    </button>
    <div class="customer-list-heading" aria-live="polite">
      <h2>{{ query.trim() ? '搜索结果' : filters.find(item => item.value === filter)?.label }} <span>{{ displayed.length }} 人</span></h2>
      <span>{{ filter === 'low' ? '余额 0–50 元' : '点客户查看档案' }}</span>
    </div>
    <div v-if="!displayed.length" class="customer-empty">
      <UsersRound :size="34" aria-hidden="true" />
      <h3>{{ query.trim() ? '未找到符合条件的客户' : filter === 'debt' ? '目前没有欠款客户' : filter === 'low' ? '目前没有低余额客户' : '还没有客户档案' }}</h3>
      <p>{{ query.trim() ? '试试姓名、完整手机号或手机尾号' : '登记客户后，即可扣款、充值和查看记录' }}</p>
      <button v-if="filter !== 'all'" type="button" class="customer-empty-secondary" @click="$emit('update:filter', 'all')">查看全部客户</button>
      <button v-if="!query.trim() || filter === 'all'" type="button" class="customer-empty-primary" :disabled="!canCreate" @click="$emit('create')">＋ 登记新客户</button>
    </div>
    <div v-else class="customer-list">
      <article v-for="member in displayed" :key="member.id" class="customer-row" :class="{ 'customer-row-debt': member.balance < 0 }">
        <button type="button" class="customer-open" :aria-label="`查看${member.name}的客户档案`" @click="$emit('select', member)">
          <span class="customer-avatar" aria-hidden="true">{{ member.name.charAt(0) }}</span>
          <span class="customer-identity">
            <strong>{{ member.name }}</strong>
            <span class="customer-phone">{{ phone(member.phone) }}</span>
            <span class="customer-visit">{{ visitLabel(member.id) }}</span>
          </span>
        </button>
        <div class="customer-row-actions">
          <span v-if="member.balance < 0" class="customer-balance-label">客户欠款</span>
          <span v-else class="customer-balance-label">{{ member.balance <= 5000 ? '低余额' : '可用余额' }}</span>
          <strong class="customer-balance" :class="{ 'balance-debt': member.balance < 0 }">{{ member.balance < 0 ? '−' : '' }}¥{{ format(Math.abs(member.balance)) }}</strong>
          <button type="button" class="customer-consume" :disabled="!canConsume" :aria-label="`为${member.name}扣款`" @click="$emit('consume', member)">扣款</button>
        </div>
      </article>
    </div>
    <p v-if="filter === 'recent' && !query.trim() && members.length > displayed.length" class="customer-list-hint">显示最近 12 位客户，搜索或切换“全部客户”查看更多</p>
  </section>
</template>

<script setup>
import { computed } from 'vue';
import { UsersRound, CircleAlert, ChevronRight } from 'lucide-vue-next';
import { customerVisits, visibleCustomers } from '../customer-view.js';

const props = defineProps({
  members: { type: Array, default: () => [] }, ledgers: { type: Array, default: () => [] },
  filter: { type: String, default: 'recent' }, query: { type: String, default: '' },
  summary: { type: Object, default: () => ({}) }, canConsume: Boolean, canCreate: Boolean
});
defineEmits(['update:filter', 'select', 'consume', 'create']);
const filters = [{ value: 'recent', label: '最近来店' }, { value: 'all', label: '全部客户' },
  { value: 'low', label: '低余额' }, { value: 'debt', label: '欠款客户' }];
const visits = computed(() => customerVisits(props.ledgers));
const displayed = computed(() => visibleCustomers(props.members, visits.value, props.filter, Boolean(props.query.trim())));
const format = cents => (cents / 100).toFixed(2);
const phone = value => /^\d{11}$/.test(value) ? value.replace(/(\d{3})(\d{4})(\d{4})/, '$1 $2 $3') : value;
function visitLabel(id) {
  const value = visits.value.get(id);
  if (!value) return '尚未消费';
  const date = new Date(value), today = new Date();
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return date.toDateString() === today.toDateString() ? `今天 ${time} 来店`
    : `${date.getFullYear() === today.getFullYear() ? '' : date.getFullYear() + '年'}${date.getMonth() + 1}月${date.getDate()}日来店`;
}
</script>
