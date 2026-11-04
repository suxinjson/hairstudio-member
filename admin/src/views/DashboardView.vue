<template>
  <div class="space-y-6">
    <!-- 顶部经营指标卡片栅格 -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
        <div class="flex items-center justify-between text-slate-500 text-xs font-bold mb-2">
          <span>总会员人数</span>
          <span class="p-2 rounded-xl bg-emerald-50 text-emerald-700 text-base">👥</span>
        </div>
        <div class="text-2xl font-black text-slate-900 tabular-nums">
          {{ members.length }} <span class="text-xs font-medium text-slate-400">人</span>
        </div>
        <div class="text-xs text-slate-400 mt-2">
          正常在用会员 {{ activeMembersCount }} 人
        </div>
      </div>

      <div class="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
        <div class="flex items-center justify-between text-slate-500 text-xs font-bold mb-2">
          <span>会员卡储值总资金</span>
          <span class="p-2 rounded-xl bg-teal-50 text-teal-700 text-base">💰</span>
        </div>
        <div class="text-2xl font-black text-emerald-700 tabular-nums">
          ¥{{ formatYuan(totalPrepaidBalance) }}
        </div>
        <div class="text-xs text-slate-400 mt-2">
          沉淀资金已保存在云端账本
        </div>
      </div>

      <div class="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
        <div class="flex items-center justify-between text-slate-500 text-xs font-bold mb-2">
          <span>待催收欠款总额</span>
          <span class="p-2 rounded-xl bg-rose-50 text-rose-700 text-base">⚠️</span>
        </div>
        <div class="text-2xl font-black text-rose-600 tabular-nums">
          ¥{{ formatYuan(totalDebtAmount) }}
        </div>
        <div class="text-xs text-rose-500 font-semibold mt-2">
          共有 {{ debtMembersCount }} 位会员尚有未结清挂账
        </div>
      </div>

      <div class="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
        <div class="flex items-center justify-between text-slate-500 text-xs font-bold mb-2">
          <span>累计流水记录</span>
          <span class="p-2 rounded-xl bg-indigo-50 text-indigo-700 text-base">📑</span>
        </div>
        <div class="text-2xl font-black text-slate-900 tabular-nums">
          {{ ledgers.length }} <span class="text-xs font-medium text-slate-400">笔</span>
        </div>
        <div class="text-xs text-slate-400 mt-2">
          包含消费、充值与冲正记录
        </div>
      </div>
    </div>

    <!-- 快捷操作与看板导流区 -->
    <div class="bg-gradient-to-r from-emerald-800 to-teal-900 text-white rounded-2xl p-6 shadow-md flex flex-wrap items-center justify-between gap-4">
      <div>
        <h2 class="text-xl font-black">PC 端高效管理中心</h2>
        <p class="text-xs text-emerald-200 mt-1">支持 Excel 快速建卡、批量数据迁移、对账单导出与细粒度员工权限审计</p>
      </div>
      <div class="flex flex-wrap gap-3">
        <button
          @click="emit('switch-tab', 'import-export')"
          class="px-4 py-2.5 bg-white text-emerald-900 rounded-xl font-bold text-sm shadow hover:bg-emerald-50 transition btn-press flex items-center gap-1.5"
        >
          <span>📥</span> 批量导入会员
        </button>
        <button
          @click="emit('switch-tab', 'members')"
          class="px-4 py-2.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded-xl font-bold text-sm transition btn-press flex items-center gap-1.5"
        >
          <span>👥</span> 会员档案总表
        </button>
        <button
          @click="emit('switch-tab', 'ledgers')"
          class="px-4 py-2.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded-xl font-bold text-sm transition btn-press flex items-center gap-1.5"
        >
          <span>📑</span> 财务对账明细
        </button>
      </div>
    </div>

    <!-- 下半部分：近期流水速览与欠款名单预警 -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- 最近流水（占2列） -->
      <div class="lg:col-span-2 bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-black text-slate-900 text-base flex items-center gap-2">
            <span>⚡</span> 最近收银流水动态
          </h3>
          <button
            @click="emit('switch-tab', 'ledgers')"
            class="text-xs font-bold text-emerald-700 hover:underline"
          >
            查看全部流水 →
          </button>
        </div>

        <div v-if="recentLedgers.length === 0" class="text-center py-10 text-slate-400 text-sm">
          暂无收银流水记录
        </div>
        <div v-else class="divide-y divide-slate-100">
          <div
            v-for="item in recentLedgers"
            :key="item.id"
            class="py-3 flex items-center justify-between text-sm gap-3"
          >
            <div class="flex items-center gap-2.5 min-w-0">
              <span
                class="px-2 py-0.5 rounded-lg text-xs font-black shrink-0"
                :class="{
                  'bg-emerald-100 text-emerald-800': item.type === 'RECHARGE',
                  'bg-slate-100 text-slate-800': item.type === 'CONSUME',
                  'bg-amber-100 text-amber-800': item.type === 'REFUND'
                }"
              >
                {{ item.type === 'RECHARGE' ? '充值' : item.type === 'REFUND' ? '撤单' : '消费' }}
              </span>
              <span class="font-black text-slate-900 truncate max-w-[120px]">{{ item.memberName }}</span>
              <span class="text-xs text-slate-400 font-mono">{{ maskPhone(item.memberPhone) }}</span>
            </div>
            <div class="text-right shrink-0">
              <div
                class="font-black tabular-nums"
                :class="item.changeAmount > 0 ? 'text-emerald-600' : 'text-slate-900'"
              >
                {{ item.changeAmount > 0 ? '+' : '' }}{{ formatYuan(item.changeAmount) }} 元
              </div>
              <div class="text-xs text-slate-400 font-medium">
                {{ formatTime(item.created_at) }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 欠款预警名单（占1列） -->
      <div class="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-black text-slate-900 text-base flex items-center gap-2">
            <span>🚨</span> 挂账欠款预警
          </h3>
          <span class="text-xs font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-full">
            {{ debtMembers.length }} 人
          </span>
        </div>

        <div v-if="debtMembers.length === 0" class="text-center py-10 text-slate-400 text-sm">
          目前全店无挂账欠款会员
        </div>
        <div v-else class="space-y-3">
          <div
            v-for="member in debtMembers.slice(0, 6)"
            :key="member.id"
            class="p-3 rounded-xl bg-rose-50/70 border border-rose-100 flex items-center justify-between"
          >
            <div>
              <div class="font-black text-slate-900 text-sm">{{ member.name }}</div>
              <div class="text-xs text-slate-400 font-mono mt-0.5">{{ maskPhone(member.phone) }}</div>
            </div>
            <div class="text-right">
              <div class="font-black text-rose-600 text-sm tabular-nums">
                -¥{{ formatYuan(Math.abs(member.balance)) }}
              </div>
              <div class="text-[11px] text-rose-500 font-medium mt-0.5">待催结还款</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { formatYuan, maskPhone } from '../utils/security.js';

const props = defineProps({
  members: { type: Array, default: () => [] },
  ledgers: { type: Array, default: () => [] }
});

const emit = defineEmits(['switch-tab']);

const activeMembersCount = computed(() => props.members.filter(m => !m.isArchived).length);

const totalPrepaidBalance = computed(() => {
  return props.members.reduce((acc, m) => acc + (m.balance > 0 ? m.balance : 0), 0);
});

const totalDebtAmount = computed(() => {
  return props.members.reduce((acc, m) => acc + (m.balance < 0 ? Math.abs(m.balance) : 0), 0);
});

const debtMembers = computed(() => {
  return props.members.filter(m => m.balance < 0);
});

const debtMembersCount = computed(() => debtMembers.value.length);

const recentLedgers = computed(() => {
  return props.ledgers.slice(0, 7);
});

function formatTime(isoStr) {
  if (!isoStr) return '—';
  try {
    const d = new Date(isoStr);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return isoStr;
  }
}
</script>
