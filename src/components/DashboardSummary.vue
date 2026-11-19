<template>
  <section class="dashboard-card cash-overview" aria-labelledby="cash-overview-title">
    <div class="cash-overview-heading"><div><p>每日简报</p><h2 id="cash-overview-title">今日收银概览</h2></div><span class="cash-ledger-state"><span aria-hidden="true"></span>{{ ledgerState }}</span></div>
    <div class="cash-metrics">
      <div><p>今日充值入账</p><strong>¥{{ formatCent(dashboard.today?.rechargeCreditTotal || 0) }}</strong><span>{{ dashboard.today?.rechargeCount || 0 }} 笔 · 含赠送额度</span></div>
      <div><p>今日消费扣款</p><strong>¥{{ formatCent(dashboard.today?.consumeAmount || 0) }}</strong><span>{{ dashboard.today?.consumeCount || 0 }} 笔有效消费</span></div>
    </div>
    <dl class="cash-snapshot">
      <div><dt>会员可用余额</dt><dd>¥{{ formatCent(dashboard.totalCreditBalance || 0) }}</dd></div>
      <div :class="{ 'cash-snapshot-debt': dashboard.totalDebt }"><dt>待收欠款<span v-if="dashboard.totalDebt"> · {{ dashboard.debtMemberCount }} 人</span></dt><dd>¥{{ formatCent(dashboard.totalDebt || 0) }}</dd></div>
      <div><dt>在用会员</dt><dd>{{ dashboard.memberCount || 0 }}<small> 人</small></dd></div>
    </dl>
    <p class="cash-overview-note">今日数据不含已撤销交易；充值入账为会员额度增加，不等同于实收营业额。</p>
  </section>
</template>
<script setup>
import { computed } from 'vue';
const props = defineProps({
  dashboard: { type: Object, default: () => ({}) },
  isNativeApp: Boolean,
  cloudState: { type: Object, default: () => ({}) },
  formatCent: { type: Function, required: true }
});
const ledgerState = computed(() => props.cloudState.webOnly
  ? (props.cloudState.status === 'synced' ? '账本已加载' : '账本待确认')
  : props.isNativeApp && !props.cloudState.binding ? '本机账本' : '账本已就绪');
</script>
