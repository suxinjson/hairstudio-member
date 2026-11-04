<template>
  <!-- 3. 会员详情卡片抽屉 (点击会员查看全貌) -->
  <div 
    v-if="member" 
    class="fixed inset-0 bg-black/60 z-40 flex flex-col justify-end animate-fade-in backdrop-blur-xs"
    @click.self="emit('close')"
  >
    <div class="member-detail-sheet bg-white rounded-t-[32px] max-h-[90vh] flex flex-col animate-slide-up shadow-2xl max-w-[500px] mx-auto w-full">
      <!-- 弹窗把手（微缩间隙，释放垂直屏幕空间） -->
      <div class="w-12 h-1 bg-slate-300 rounded-full mx-auto mt-2 mb-1 shrink-0"></div>

      <div class="modal-header px-4 py-2.5 border-b border-slate-100 flex items-center justify-between gap-2">
        <div class="member-detail-header-copy flex items-center space-x-3 min-w-0">
          <div class="w-12 h-12 rounded-2xl bg-gradient-to-tr from-indigo-700 to-slate-900 text-white flex items-center justify-center font-black text-xl shadow-xs shrink-0">
            {{ member.name.charAt(0) }}
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <button class="copyable-text font-black text-xl text-slate-900 truncate max-w-[130px] sm:max-w-[180px] whitespace-nowrap text-left" @click.stop="emit('copy', member.name, '姓名')" aria-label="复制会员姓名">{{ member.name }}</button>
              <span class="text-[11px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full font-black whitespace-nowrap shrink-0" :class="{ 'debt-tag': member.balance < 0 }">{{ member.balance < 0 ? '尚有欠款' : '客户档案' }}</span>
            </div>
            <button class="copyable-text block text-base text-slate-800 font-mono font-black tracking-wide whitespace-nowrap mt-0.5 text-left" @click.stop="emit('copy', member.phone, '手机号')" aria-label="复制会员手机号">{{ formatPhoneSpaced(member.phone) }}</button>
          </div>
        </div>
        <div class="flex items-center space-x-1.5 shrink-0">
          <button 
            @click="emit('edit', member)"
            class="h-8.5 px-3 bg-indigo-50 border border-indigo-200 text-indigo-700 rounded-xl font-bold text-xs active:bg-indigo-100 btn-press whitespace-nowrap"
          >
            修改档案
          </button>
          <button 
            @click="emit('close')" 
            class="w-8.5 h-8.5 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-lg font-bold btn-press shrink-0"
            aria-label="关闭详情"
          >
            ✕
          </button>
        </div>
      </div>

      <div class="member-detail-content flex-1 overflow-y-auto p-3.5 space-y-2.5">
        <!-- 醒目大额度黑金渐变卡片（紧凑内衬，突出余额与欠款） -->
        <div class="member-balance-panel rounded-3xl p-4" :class="{ 'member-balance-debt': member.balance < 0 }">
          <div class="text-xs sm:text-sm font-black">{{ member.balance < 0 ? '客户当前欠款' : '当前可用余额' }}</div>
          <div class="text-3xl sm:text-4xl font-black tracking-tight mt-1 tabular-nums">
            {{ member.balance < 0 ? '−' : '' }}¥ {{ formatCent(Math.abs(member.balance)) }}
          </div>
          <div v-if="member.balance < 0" class="mt-2 text-xs sm:text-sm font-black text-rose-700 bg-rose-50 px-3 py-1.5 rounded-xl border border-rose-200 flex items-center space-x-1">
            <span>⚠️</span>
            <span>待收回欠款 ¥{{ formatCent(-member.balance) }}（充值将自动优先结清欠款）</span>
          </div>

          <div class="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-slate-800/80 text-xs">
            <div>
              <span class="text-slate-400 font-medium">历史累计充值：</span>
              <span class="font-bold tabular-nums">¥{{ formatCent(member.total_recharge) }}</span>
            </div>
            <div>
              <span class="text-slate-400 font-medium">历史累计消费：</span>
              <span class="font-bold tabular-nums">¥{{ formatCent(member.total_consume) }}</span>
            </div>
          </div>
        </div>

        <!-- 发型偏好说明（理发店重点业务信息，大字醒目暖金色卡片） -->
        <div v-if="member.notes" class="bg-amber-50/90 p-3.5 rounded-2xl border-2 border-amber-300 text-amber-950 shadow-xs">
          <div class="flex items-center space-x-1.5 text-xs font-black text-amber-900 tracking-wide uppercase mb-1">
            <span class="text-base" aria-hidden="true">💇</span>
            <span>熟客发型与剪发习惯（重点注意）</span>
          </div>
          <div class="text-base font-black text-amber-950 leading-relaxed pl-5 break-words">
            {{ member.notes }}
          </div>
        </div>

        <!-- 近期交易明细 -->
        <div>
          <div class="text-xs font-black uppercase tracking-wider text-slate-500 mb-1.5">
            近期消费与充值记录 ({{ ledgers.length }})
          </div>

          <div v-if="ledgers.length === 0" class="text-sm text-slate-400 py-3 text-center font-bold">
            暂无历史记录
          </div>
          <div v-else class="space-y-2">
            <div 
              v-for="l in ledgers" 
              :key="l.id"
              class="bg-slate-50 p-3 rounded-2xl border border-slate-200 flex items-center justify-between text-xs"
            >
              <div class="min-w-0 pr-2">
                <div class="flex items-center space-x-1.5">
                  <span 
                    class="px-2 py-0.5 rounded-lg text-[11px] font-black shrink-0 whitespace-nowrap"
                    :class="getBadgeClass(l.type)"
                  >
                    {{ getTypeText(l.type) }}
                  </span>
                  <span class="font-black text-slate-800 text-sm truncate max-w-[150px]">{{ l.remark || '无' }}</span>
                </div>
                <div class="text-slate-400 mt-1 font-medium whitespace-nowrap">
                  {{ formatTime(l.created_at) }}
                </div>
              </div>

              <div class="text-right shrink-0">
                <div 
                  class="font-black tabular-nums text-base"
                  :class="l.changeAmount > 0 ? 'text-emerald-600' : 'text-slate-900'"
                >
                  {{ l.changeAmount > 0 ? '+' : '' }}{{ (l.changeAmount / 100).toFixed(2) }}
                </div>
                <div class="text-slate-400 font-medium whitespace-nowrap">
                  <span :class="{ 'balance-debt': l.balanceAfter < 0 }">{{ l.balanceAfter < 0 ? '欠款' : '余额' }}: ¥{{ formatCent(Math.abs(l.balanceAfter)) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 删除会员 (仅当余额为0时) -->
        <div v-if="member.balance === 0" class="pt-1 text-center">
          <button 
            @click="emit('delete', member)"
            :disabled="!canWrite('deleteMember')"
            class="text-xs text-rose-500 underline font-bold"
          >
            删除注销此会员档案 (仅限余额为0)
          </button>
        </div>
      </div>

      <!-- 底部快捷充值与扣款 (大按钮52px，通俗明白大白话) -->
      <div class="member-detail-actions border-t border-slate-200 bg-white grid grid-cols-2 pb-gesture-safe">
        <button 
          @click="emit('recharge', member)"
          :disabled="!canWrite('recharge')"
          class="h-13 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-2xl font-black text-base shadow-md shadow-emerald-500/20 flex items-center justify-center space-x-1.5 btn-press"
        >
          <span class="detail-action-icon" aria-hidden="true">💳</span><span>{{ member.balance < 0 ? '充值 / 还款' : '充值' }}<span class="sr-only"> (额度充值)</span></span>
        </button>

        <button 
          @click="emit('consume', member)"
          :disabled="!canWrite('consume')"
          class="h-13 bg-gradient-to-r from-rose-500 to-rose-600 hover:from-rose-600 hover:to-rose-700 text-white rounded-2xl font-black text-base shadow-md shadow-rose-500/20 flex items-center justify-center space-x-1.5 btn-press"
        >
          <span class="detail-action-icon" aria-hidden="true">✂️</span><span>剪发扣款</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  member: { type: Object, default: null },
  ledgers: { type: Array, default: () => [] },
  canWrite: { type: Function, default: () => true },
  formatPhoneSpaced: { type: Function, required: true },
  formatCent: { type: Function, required: true },
  formatTime: { type: Function, required: true },
  getTypeText: { type: Function, required: true },
  getBadgeClass: { type: Function, required: true }
});

const emit = defineEmits(['close', 'edit', 'copy', 'recharge', 'consume', 'delete']);
</script>
