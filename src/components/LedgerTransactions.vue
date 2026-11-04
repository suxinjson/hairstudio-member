<template>
  <div id="ledger-transactions" role="tabpanel" aria-labelledby="ledger-transactions-tab" class="space-y-3">
    <!-- 筛选标签（清晰单行，永不折行） -->
    <div class="grid grid-cols-4 gap-1.5 bg-slate-200/80 p-1.5 rounded-2xl text-sm font-black">
      <button
        v-for="type in [{ key: '', label: '全部' }, { key: 'CONSUME', label: '扣款' }, { key: 'RECHARGE', label: '充值' }, { key: 'REFUND', label: '撤单' }]"
        :key="type.key"
        @click="emit('update:filterType', type.key)"
        class="py-2.5 px-1 rounded-xl transition text-center whitespace-nowrap btn-press"
        :class="filterType === type.key ? 'bg-white text-emerald-800 font-black shadow-sm ring-1 ring-emerald-600/20' : 'text-slate-600 hover:text-slate-900'"
      >
        {{ type.label }}
      </button>
    </div>

    <div v-if="ledgers.length === 0" class="bg-white rounded-3xl p-8 text-center border border-slate-200/90 text-slate-500 text-base font-bold">
      {{ searchQuery ? '没有找到匹配的流水，请换个姓名、手机号或关键词试试' : '暂无相关账目流水' }}
    </div>
    <div v-else class="space-y-2.5">
      <div
        v-for="item in ledgers"
        :key="item.id"
        class="ledger-item-card bg-white p-3.5 sm:p-4 rounded-2xl border border-slate-200/90 shadow-[0_2px_8px_rgba(0,0,0,0.03)] text-sm space-y-2 transition"
      >
        <!-- 首行：业务类型 + 会员全名 与 变动金额 -->
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <span
              class="px-2 py-0.5 rounded-lg font-black text-xs whitespace-nowrap shrink-0"
              :class="getBadgeClass(item.type)"
            >
              {{ getTypeText(item.type) }}<span class="sr-only" v-if="item.type === 'RECHARGE'">(储值)</span>
            </span>
            <button
              class="copyable-text font-black text-slate-900 text-base sm:text-lg break-words text-left"
              @click.stop="emit('copy', item.memberName, '会员姓名')"
              aria-label="复制会员姓名"
            >
              {{ item.memberName }}
            </button>
          </div>
          <div
            class="text-right shrink-0 text-lg sm:text-xl font-black tabular-nums whitespace-nowrap"
            :class="item.changeAmount > 0 ? 'text-emerald-600' : 'text-slate-900'"
          >
            {{ item.changeAmount > 0 ? '+' : '' }}{{ (item.changeAmount / 100).toFixed(2) }} 元
          </div>
        </div>

        <!-- 次行：手机号 与 变动后余额（独立行排布，左右呼应，绝不重叠） -->
        <div class="flex items-center justify-between gap-2 text-xs sm:text-sm">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="text-slate-400 font-normal shrink-0">手机</span>
            <button
              class="copyable-text font-mono font-bold text-slate-600 whitespace-nowrap"
              @click.stop="emit('copy', item.memberPhone, '会员手机号')"
              aria-label="复制会员手机号"
            >
              {{ formatPhoneSpaced(item.memberPhone) }}
            </button>
          </div>
          <div class="text-right whitespace-nowrap shrink-0 text-slate-500 font-medium">
            <span class="text-slate-400 font-normal">{{ item.balanceAfter < 0 ? '变动后欠款' : '变动后余额' }}：</span>
            <strong
              class="font-black tabular-nums text-sm"
              :class="item.balanceAfter < 0 ? 'balance-debt' : 'text-slate-900'"
            >
              ¥{{ formatCent(Math.abs(item.balanceAfter)) }}
            </strong>
          </div>
        </div>

        <!-- 项目明细（如果有） -->
        <div v-if="item.remark" class="pt-1.5 border-t border-slate-100 text-xs text-slate-600 font-medium break-words">
          <span class="text-slate-400 font-normal">项目明细：</span>{{ item.remark }}
        </div>

        <!-- 底行：时间与撤单操作 -->
        <div class="pt-1.5 border-t border-dashed border-slate-100 flex items-center justify-between text-xs text-slate-400">
          <span class="font-medium font-mono whitespace-nowrap">{{ formatTime(item.created_at) }}</span>

          <button
            v-if="item.type !== 'REFUND' && !item.isRefunded"
            @click.stop="emit('refund', item)"
            :disabled="!canWrite('refundLedger')"
            class="text-rose-600 hover:text-rose-700 bg-rose-50 border border-rose-200/80 px-3 py-1 rounded-xl font-bold active:bg-rose-100 text-xs btn-press whitespace-nowrap"
          >
            撤销此单
          </button>
          <span v-else-if="item.isRefunded" class="text-slate-400 bg-slate-100 px-2.5 py-0.5 rounded-xl font-medium whitespace-nowrap">
            已撤销冲正
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  filterType: { type: String, default: '' },
  ledgers: { type: Array, default: () => [] },
  searchQuery: { type: String, default: '' },
  canWrite: { type: Function, default: () => true },
  getBadgeClass: { type: Function, required: true },
  getTypeText: { type: Function, required: true },
  formatPhoneSpaced: { type: Function, required: true },
  formatCent: { type: Function, required: true },
  formatTime: { type: Function, required: true }
});

const emit = defineEmits(['update:filterType', 'copy', 'refund']);
</script>
