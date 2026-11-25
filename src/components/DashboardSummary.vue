<template>
  <section class="dashboard-card cash-overview bg-white rounded-2xl p-4 border border-slate-200 shadow-sm" aria-labelledby="cash-overview-title">
    <div class="cash-overview-heading flex items-center justify-between mb-3 pb-2 border-b border-slate-100">
      <div>
        <p class="text-xs font-semibold text-slate-500">每日简报</p>
        <h2 id="cash-overview-title" class="text-lg font-black text-slate-900 mt-0.5">今日收银概览</h2>
      </div>
      <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
        <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
        <span>账本已就绪</span>
      </span>
    </div>

    <div class="cash-metrics grid grid-cols-2 gap-3 mb-3">
      <div class="bg-emerald-50/70 p-3 rounded-xl border border-emerald-100">
        <p class="text-xs font-bold text-emerald-800">今日充值入账</p>
        <strong class="text-xl font-black text-emerald-900 block mt-1">¥{{ displayCents(summary?.rechargeCreditCents || '0') }}</strong>
        <span class="text-[11px] text-emerald-700 font-medium block mt-0.5">{{ summary?.rechargeCount || 0 }} 笔 · 含赠送</span>
      </div>
      <div class="bg-amber-50/70 p-3 rounded-xl border border-amber-100">
        <p class="text-xs font-bold text-amber-800">今日消费扣款</p>
        <strong class="text-xl font-black text-amber-900 block mt-1">¥{{ displayCents(summary?.consumptionCents || '0') }}</strong>
        <span class="text-[11px] text-amber-700 font-medium block mt-0.5">{{ summary?.consumeCount || 0 }} 笔有效消费</span>
      </div>
    </div>

    <dl class="cash-snapshot grid grid-cols-3 gap-2 p-3 bg-slate-50 rounded-xl border border-slate-200 text-center text-xs">
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
  </section>
</template>

<script setup>
import { displayAbsoluteCents, displayCents } from '../relational-presentation.js';

defineProps({
  summary: { type: Object, default: () => ({}) },
  balances: { type: Object, default: () => ({}) }
});
</script>
