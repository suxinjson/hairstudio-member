<template>
  <div id="ledger-transactions" role="tabpanel" aria-labelledby="ledger-transactions-tab" class="space-y-3.5">
    <!-- 筛选标签（大白话清晰单行，永不折行） -->
    <div class="grid grid-cols-4 gap-1.5 bg-slate-200/80 p-1.5 rounded-2xl text-sm font-black">
      <button
        v-for="type in [{ key: '', label: '全部' }, { key: 'CONSUME', label: '扣款' }, { key: 'RECHARGE', label: '充值' }, { key: 'REFUND', label: '撤单' }]"
        :key="type.key"
        @click="emit('update:filterType', type.key)"
        class="py-2.5 px-1 rounded-xl transition text-center whitespace-nowrap btn-press"
        :class="filterType === type.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'"
      >
        {{ type.label }}
      </button>
    </div>

    <div v-if="ledgers.length === 0" class="bg-white rounded-3xl p-8 text-center border border-slate-200/90 text-slate-500 text-base font-bold">
      {{ searchQuery ? '没有找到匹配的流水，请换个姓名、手机号或关键词试试' : '暂无相关账目流水' }}
    </div>
    <div v-else class="space-y-3">
      <div
        v-for="item in ledgers"
        :key="item.id"
        class="ledger-item-card bg-white p-4 rounded-2xl border border-slate-200/90 shadow-[0_2px_8px_rgba(0,0,0,0.03)] text-sm transition"
      >
        <!-- 头部：会员身份（头像 + 姓名 + 业务标签 + 电话）与变动金额 -->
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-center gap-3 min-w-0 flex-1">
            <!-- 会员首字头像 -->
            <div
              class="w-11 h-11 rounded-xl flex items-center justify-center font-black text-lg shrink-0 select-none"
              :class="{
                'bg-emerald-100 text-emerald-800': item.type === 'RECHARGE',
                'bg-slate-100 text-slate-800': item.type === 'CONSUME',
                'bg-amber-100 text-amber-800': item.type === 'REFUND'
              }"
              aria-hidden="true"
            >
              {{ item.memberName ? item.memberName.charAt(0) : '会' }}
            </div>

            <!-- 姓名、标签与电话 -->
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <button
                  class="copyable-text font-black text-slate-900 text-base sm:text-lg whitespace-nowrap truncate max-w-[130px] sm:max-w-[180px]"
                  @click.stop="emit('copy', item.memberName, '会员姓名')"
                  aria-label="复制会员姓名"
                >
                  {{ item.memberName }}
                </button>
                <span
                  class="px-2 py-0.5 rounded-lg font-black text-xs whitespace-nowrap shrink-0"
                  :class="getBadgeClass(item.type)"
                >
                  {{ getTypeText(item.type) }}<span class="sr-only" v-if="item.type === 'RECHARGE'">(储值)</span>
                </span>
              </div>
              <div class="mt-0.5">
                <button
                  class="copyable-text text-slate-500 font-mono font-bold text-xs sm:text-sm whitespace-nowrap"
                  @click.stop="emit('copy', item.memberPhone, '会员手机号')"
                  aria-label="复制会员手机号"
                >
                  {{ formatPhoneSpaced(item.memberPhone) }}
                </button>
              </div>
            </div>
          </div>

          <!-- 右侧：本次变动金额与变动后余额 -->
          <div class="text-right shrink-0">
            <div
              class="text-lg sm:text-xl font-black tabular-nums whitespace-nowrap"
              :class="item.changeAmount > 0 ? 'text-emerald-600' : 'text-slate-900'"
            >
              {{ item.changeAmount > 0 ? '+' : '' }}{{ (item.changeAmount / 100).toFixed(2) }} 元
            </div>
            <div class="text-xs text-slate-500 font-semibold mt-0.5 whitespace-nowrap">
              {{ item.balanceAfter < 0 ? '变动后欠款' : '变动后余额' }}:
              <strong
                class="font-black tabular-nums whitespace-nowrap"
                :class="item.balanceAfter < 0 ? 'balance-debt' : 'text-slate-900'"
              >
                ¥{{ formatCent(Math.abs(item.balanceAfter)) }}
              </strong>
            </div>
          </div>
        </div>

        <!-- 中部：服务明细/备注 -->
        <div v-if="item.remark" class="mt-2.5 pt-2 border-t border-slate-100 text-xs text-slate-600 font-medium break-words">
          <span class="text-slate-400 font-normal">项目明细：</span>{{ item.remark }}
        </div>

        <!-- 底部：时间与撤单操作 -->
        <div class="mt-2.5 pt-2 border-t border-dashed border-slate-100 flex items-center justify-between text-xs text-slate-400">
          <span class="font-medium font-mono whitespace-nowrap">{{ formatTime(item.created_at) }}</span>

          <button
            v-if="item.type !== 'REFUND' && !item.isRefunded"
            @click.stop="emit('refund', item)"
            :disabled="!canWrite('refundLedger')"
            class="text-rose-600 hover:text-rose-700 bg-rose-50 border border-rose-200/80 px-3.5 py-1.5 rounded-xl font-bold active:bg-rose-100 text-xs btn-press whitespace-nowrap"
          >
            撤销此单
          </button>
          <span v-else-if="item.isRefunded" class="text-slate-400 bg-slate-100 px-2.5 py-1 rounded-xl font-medium whitespace-nowrap">
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
