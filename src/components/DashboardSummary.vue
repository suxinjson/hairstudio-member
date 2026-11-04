<template>
  <!-- 今日营业收支卡片 (高档清爽配色，清晰大字) -->
  <div class="dashboard-card bg-white rounded-3xl p-4.5 shadow-[0_2px_12px_rgba(0,0,0,0.04)] border border-slate-200/90">
    <div class="flex items-center justify-between pb-3 border-b border-slate-100">
      <span class="text-sm font-black text-slate-800 flex items-center space-x-2">
        <span class="text-base">📊</span>
        <span>今日小店收银简报</span>
      </span>
      <span class="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-1 rounded-full font-bold">
        ✓ {{ isNativeApp && !cloudState?.binding ? '数据保存在本机' : '账本状态正常' }}
      </span>
    </div>

    <div class="grid grid-cols-2 gap-3 mt-3.5">
      <div class="bg-gradient-to-br from-emerald-50/80 to-teal-50/40 p-4 rounded-2xl border border-emerald-100">
        <div class="text-xs text-emerald-800 font-bold">今日充值到账</div>
        <div class="text-2xl font-black text-emerald-600 tabular-nums mt-1">
          ¥ {{ formatCent(dashboard.today?.rechargeCreditTotal || 0) }}
        </div>
        <div class="text-xs text-emerald-700 font-medium mt-1">
          入账 {{ dashboard.today?.rechargeCount || 0 }} 笔
        </div>
      </div>

      <div class="bg-gradient-to-br from-rose-50/80 to-orange-50/40 p-4 rounded-2xl border border-rose-100">
        <div class="text-xs text-rose-800 font-bold">今日服务扣款</div>
        <div class="text-2xl font-black text-rose-600 tabular-nums mt-1">
          ¥ {{ formatCent(dashboard.today?.consumeAmount || 0) }}
        </div>
        <div class="text-xs text-rose-700 font-medium mt-1">
          到店服务 {{ dashboard.today?.consumeCount || 0 }} 人次
        </div>
      </div>
    </div>

    <div class="mt-3.5 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 font-semibold gap-2 flex-wrap sm:flex-nowrap">
      <div class="whitespace-nowrap">
        会员可用总余额：<strong class="text-slate-900 text-sm font-black tabular-nums whitespace-nowrap">¥ {{ formatCent(dashboard.totalCreditBalance || 0) }}</strong>
      </div>
      <div v-if="dashboard.totalDebt" class="debt-dashboard-line whitespace-nowrap">会员待收欠款：<strong>¥ {{ formatCent(dashboard.totalDebt) }}</strong> · {{ dashboard.debtMemberCount }} 人</div>
      <div class="whitespace-nowrap">
        总会员数：<strong class="text-slate-900 text-sm font-black whitespace-nowrap">{{ dashboard.memberCount || 0 }}</strong> 人
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  dashboard: { type: Object, default: () => ({}) },
  isNativeApp: Boolean,
  cloudState: { type: Object, default: () => ({}) },
  formatCent: { type: Function, required: true }
});
</script>
