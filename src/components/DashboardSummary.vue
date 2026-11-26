<template>
  <section class="dashboard-card cash-overview bg-white rounded-2xl p-4 border border-slate-200 shadow-sm" aria-labelledby="cash-overview-title">
    <div class="cash-overview-heading flex items-center justify-between mb-3 pb-2 border-b border-slate-100">
      <h2 id="cash-overview-title" class="text-lg font-bold text-slate-900">经营概览</h2>
      <p class="cash-period text-xs text-slate-500">{{ periodLabel }}</p>
    </div>

    <div class="cash-metrics grid grid-cols-2 gap-3 mb-3">
      <div class="bg-emerald-50/70 p-3 rounded-xl border border-emerald-100">
        <p class="text-xs font-bold text-emerald-800">净实收充值</p>
        <strong class="text-xl font-black text-emerald-900 block mt-1">¥{{ displayCents(summary?.netActualPayCents ?? String(BigInt(summary?.actualPayCents || '0') - BigInt(summary?.reversedActualPayCents || '0'))) }}</strong>
        <span class="text-[11px] text-emerald-700 font-medium block mt-0.5">赠送净额 ¥{{ displayCents(summary?.netGiftCents ?? String(BigInt(summary?.giftCents || '0') - BigInt(summary?.reversedGiftCents || '0'))) }}</span>
      </div>
      <div class="bg-amber-50/70 p-3 rounded-xl border border-amber-100">
        <p class="text-xs font-bold text-amber-800">净消费扣款</p>
        <strong class="text-xl font-black text-amber-900 block mt-1">¥{{ displayCents(summary?.netConsumptionCents || '0') }}</strong>
        <span class="text-[11px] text-amber-700 font-medium block mt-0.5">消费 {{ summary?.consumeCount || 0 }} 笔 · 冲正 {{ summary?.reversedConsumeCount || 0 }} 笔</span>
      </div>
    </div>

    <dl class="cash-snapshot grid grid-cols-3 gap-2 p-3 bg-slate-50 rounded-xl border border-slate-200 text-center text-xs" :class="{ 'cash-snapshot-large': displayCents(balances?.storedCents || '0').length > 12 || displayAbsoluteCents(balances?.debtCents || '0').length > 12 }">
      <div>
        <dt class="text-slate-500 font-medium">会员可用余额</dt>
        <dd class="text-sm font-black text-slate-900 mt-0.5">¥{{ displayCents(balances?.storedCents || '0') }}</dd>
      </div>
      <div>
        <dt class="text-slate-500 font-medium">待收欠款<span v-if="balances?.debtCount"> · {{ balances.debtCount }}人</span></dt>
        <dd class="text-sm font-black text-rose-600 mt-0.5">¥{{ displayAbsoluteCents(balances?.debtCents || '0') }}</dd>
      </div>
      <div>
        <dt class="text-slate-500 font-medium">在用会员</dt>
        <dd class="text-sm font-black text-slate-900 mt-0.5">{{ balances?.memberCount || 0 }}<small class="font-normal text-slate-500"> 人</small></dd>
      </div>
    </dl>
    <details class="cash-balance-distribution">
      <summary>会员余额分布 <small>当前账户</small></summary>
      <dl>
        <div><dt>50元以上</dt><dd>{{ balances?.fundedCount || 0 }} 人</dd></div>
        <div><dt>0.01–50元</dt><dd>{{ balances?.lowCount || 0 }} 人</dd></div>
        <div><dt>零余额</dt><dd>{{ balances?.zeroCount || 0 }} 人</dd></div>
        <div><dt>欠款会员</dt><dd>{{ balances?.debtCount || 0 }} 人</dd></div>
      </dl>
      <p>低余额名单含零余额及 0.01–50 元两档。</p>
    </details>
  </section>
</template>

<script setup>
import { displayAbsoluteCents, displayCents } from '../relational-presentation.js';

defineProps({
  periodLabel: { type: String, default: '今日' },
  summary: { type: Object, default: () => ({}) },
  balances: { type: Object, default: () => ({}) }
});
</script>
