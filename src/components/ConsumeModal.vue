<template>
  <div v-if="member">
    <!-- 消费抽屉 -->
    <div 
      class="app-modal-backdrop consume-backdrop fixed inset-0 bg-black/60 z-50 flex flex-col justify-end animate-fade-in backdrop-blur-xs"
      @click.self="emit('backdrop-back')"
    >
      <section 
        class="app-modal-surface consume-sheet bg-white animate-slide-up"
        :class="{ 'consume-sheet-debt': isConsumeOverBalance }"
        role="dialog" 
        aria-modal="true" 
        aria-labelledby="consume-sheet-title"
      >
        <header class="consume-header">
          <div class="consume-header-copy">
            <h2 id="consume-sheet-title" class="modal-title">消费扣款 <span>{{ member.name }}</span></h2>
            <p>{{ member.balance < 0 ? '当前欠款' : '可用余额' }}
              <strong :class="{ 'balance-debt': member.balance < 0 }">¥{{ formatCent(Math.abs(member.balance)) }}</strong>
            </p>
          </div>
          <button type="button" @click="emit('close')" class="consume-close" aria-label="关闭消费扣款">✕</button>
        </header>

        <div class="consume-amount-panel" :class="{ 'consume-amount-debt': isConsumeOverBalance, 'consume-amount-active': showKeypad }">
          <div class="consume-amount-heading">
            <span>本次扣款</span>
            <button v-if="amountStr" type="button" @click="emit('clear-amount')" class="consume-clear" aria-label="清空扣款金额">清空</button>
          </div>
          <button type="button" @click="emit('open-keypad')" class="consume-amount-edit cursor-pointer" aria-label="修改扣款金额" :aria-expanded="showKeypad">
            <span class="consume-currency">¥</span>
            <strong>{{ amountStr || '0.00' }}</strong>
            <span class="consume-edit-hint">{{ showKeypad ? '正在改价' : '点击改价' }}</span>
          </button>
          <div v-if="isConsumeOverBalance" class="debt-warning consume-debt-warning" role="status" aria-live="polite">
            <strong>{{ member.balance < 0 ? '会员已有欠款' : '余额不足，将记录欠款' }}</strong>
            <span class="whitespace-nowrap">本次新增欠款 ¥{{ formatCent(consumeDebtAdded) }} · 累计欠款 ¥{{ formatCent(-consumeBalanceAfter) }}</span>
          </div>
        </div>

        <div class="consume-content">
          <p v-if="member.notes" class="consume-preference"><strong>{{ notesLabel }}</strong><span>{{ member.notes }}</span></p>
          <div class="consume-section-heading"><h3>常用项目</h3><span>选项目自动带入金额</span></div>
          <div class="consume-presets">
            <button v-for="item in services" :key="item.id" @click="emit('set-preset', item)" type="button"
              class="consume-preset" :title="item.name" :aria-label="item.name + ' (¥' + item.price + ')'"
              :aria-pressed="summary === item.name && amountStr === item.price.toString()">
              <span class="consume-preset-name">{{ item.name }}</span><strong>¥{{ item.price }}</strong>
            </button>
          </div>
          <div v-if="!services.length" class="consume-empty">暂无常用项目，请修改金额并填写服务明细。</div>
          <label class="consume-description">项目明细备注
            <input :value="summary" @input="emit('update:summary', $event.target.value)" @focus="emit('update:showKeypad', false)" type="text" maxlength="512"
              placeholder="填写服务项目或补充说明" />
          </label>
          <button v-if="isConsumeOverBalance" type="button" class="consume-recharge-link" :disabled="!canWrite('recharge')" @click="emit('recharge', member)">先充值 / 还款</button>
        </div>

        <footer class="consume-footer">
          <div class="consume-footer-controls">
            <span class="consume-result" :class="{ 'balance-debt': isConsumeOverBalance }">
              <template v-if="canSubmit">{{ isConsumeOverBalance ? '扣后欠款' : '扣后余额' }} <strong>¥{{ formatCent(Math.abs(consumeBalanceAfter)) }}</strong></template>
              <template v-else>请输入扣款金额</template>
            </span>
            <button type="button" @click="emit('toggle-keypad')" class="consume-keypad-toggle" :aria-expanded="showKeypad">
              {{ showKeypad ? '收起键盘' : '展开键盘' }} <span aria-hidden="true">{{ showKeypad ? '⌄' : '⌃' }}</span>
            </button>
          </div>
          <div v-show="showKeypad" class="consume-keypad">
            <Keypad :model-value="amountStr" @update:model-value="emit('update:amountStr', $event)" :confirm-text="isConsumeOverBalance ? '核对欠款' : '确认扣除'" theme="danger"
              :disabled="!canSubmit || isSubmitting || !canWrite('consume')" @confirm="emit('request-confirm')" />
          </div>
          <div v-show="!showKeypad" class="consume-payment">
            <strong class="consume-payment-amount" :class="{ 'balance-debt': isConsumeOverBalance }">¥{{ amountStr || '0.00' }}</strong>
            <button type="button" @click="emit('open-keypad')" class="consume-change-amount" aria-label="点击弹出数字键盘修改">改金额</button>
            <button type="button" @click="emit('request-confirm')"
              :disabled="isSubmitting || !canSubmit || !canWrite('consume')"
              class="consume-submit" :class="{ 'consume-submit-debt': isConsumeOverBalance }">{{ isConsumeOverBalance ? '核对欠款' : '确认扣除' }}</button>
          </div>
        </footer>
      </section>
    </div>

    <!-- 消费金额确认框 (二次防误触核对) -->
    <div
      v-if="confirmation"
      class="app-modal-backdrop feedback-backdrop fixed inset-0 z-[60] flex items-center justify-center p-5 animate-fade-in backdrop-blur-xs"
      @click.self="emit('cancel-confirm')"
    >
      <section 
        class="app-modal-surface feedback-dialog consume-confirm-dialog w-full max-w-sm bg-white text-center shadow-2xl"
        :class="{ 'debt-confirm-dialog': confirmation.balanceAfter < 0 }"
        :role="confirmation.balanceAfter < 0 ? 'alertdialog' : 'dialog'"
        aria-modal="true" 
        aria-labelledby="consume-confirm-title"
      >
        <div class="feedback-icon mx-auto text-3xl font-black bg-rose-100 text-rose-600">
          <CircleAlert v-if="confirmation.balanceAfter < 0" :size="30" aria-hidden="true" />
          <span v-else aria-hidden="true">💳</span>
        </div>
        <h2 id="consume-confirm-title" class="mt-4 text-2xl font-black text-slate-900" :class="{ 'balance-debt': confirmation.balanceAfter < 0 }">
          {{ confirmation.balanceAfter < 0 ? '注意：本次扣款将产生欠款' : '请核对扣款金额' }}
        </h2>
        <p class="mt-2 text-base text-slate-700">
          {{ confirmation.balanceAfter < 0 ? '确认后将记录服务消费和欠款，请核对会员与金额。' : `确认后将立即从 ${confirmation.memberName} 会员卡中扣款。` }}
        </p>
        <div class="feedback-amount mt-5 rounded-xl px-4 py-4 text-left">
          <div class="flex justify-between gap-3 text-base"><span>消费会员</span><strong class="text-slate-900">{{ confirmation.memberName }}</strong></div>
          <div class="mt-2 flex justify-between gap-3 text-sm"><span>手机号</span><strong>{{ formatPhoneSpaced(confirmation.memberPhone) }}</strong></div>
          <div class="mt-2 flex justify-between gap-3 text-base"><span>服务项目</span><strong class="text-slate-800 max-w-[170px] truncate text-right">{{ confirmation.itemsSummary }}</strong></div>
          <div class="mt-2 flex justify-between gap-3 text-base"><span>{{ confirmation.currentBalance < 0 ? '原有欠款' : '当前余额' }}</span><strong :class="{ 'balance-debt': confirmation.currentBalance < 0 }">¥{{ formatCent(Math.abs(confirmation.currentBalance)) }}</strong></div>
          <div class="mt-3 border-t border-rose-200 pt-3 flex justify-between items-baseline gap-3 text-xl font-black text-rose-700">
            <span>扣款金额</span>
            <strong class="text-2xl tabular-nums">¥{{ confirmation.amount.toFixed(2) }}</strong>
          </div>
          <div class="mt-2.5 border-t border-dashed border-rose-200/80 pt-2 flex justify-between gap-3 text-sm text-slate-600 font-semibold">
            <span>{{ confirmation.balanceAfter < 0 ? '扣款后累计欠款' : '扣款后可用余额' }}</span>
            <strong class="text-indigo-600 font-black tabular-nums" :class="{ 'balance-debt': confirmation.balanceAfter < 0 }">¥{{ formatCent(Math.abs(confirmation.balanceAfter)) }}</strong>
          </div>
        </div>
        <div v-if="confirmation.balanceAfter < 0" class="debt-confirm-warning">
          <strong>新增欠款 ¥{{ formatCent(confirmation.debtAdded) }}</strong>
          <p>确认后余额为负数，该会员累计欠款 ¥{{ formatCent(-confirmation.balanceAfter) }}，需后续收款结清。</p>
          <label class="debt-acknowledgement">
            <input :checked="debtAcknowledged" @change="emit('update:debtAcknowledged', $event.target.checked)" type="checkbox" />
            <span>我已知晓并同意记录本次欠款</span>
          </label>
        </div>
        <div class="mt-6 grid grid-cols-2 gap-3">
          <button @click="emit('cancel-confirm')" class="h-14 rounded-xl border-2 border-slate-300 text-base font-bold text-slate-700 btn-press">返回修改</button>
          <button 
            @click="emit('confirm')" 
            :disabled="isSubmitting || !canWrite('consume') || (confirmation.balanceAfter < 0 && !debtAcknowledged)" 
            class="consume-submit h-14 rounded-xl text-base font-black text-white btn-press disabled:opacity-60 flex items-center justify-center space-x-1.5" 
            :class="{ 'consume-submit-debt': confirmation.balanceAfter < 0 }"
          >
            <span v-if="isSubmitting">扣款中...</span>
            <span v-else>{{ confirmation.balanceAfter < 0 ? '确认并记欠款' : '确认扣款' }}</span>
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { CircleAlert } from 'lucide-vue-next';
import Keypad from './Keypad.vue';

defineProps({
  notesLabel: { type: String, default: '会员偏好与备注' },
  member: { type: Object, default: null },
  services: { type: Array, default: () => [] },
  amountStr: { type: String, default: '' },
  summary: { type: String, default: '' },
  showKeypad: { type: Boolean, default: false },
  debtAcknowledged: { type: Boolean, default: false },
  confirmation: { type: Object, default: null },
  isSubmitting: { type: Boolean, default: false },
  consumeBalanceAfter: { type: Number, default: null },
  consumeDebtAdded: { type: Number, default: 0 },
  isConsumeOverBalance: { type: Boolean, default: false },
  canSubmit: { type: Boolean, default: false },
  canWrite: { type: Function, default: () => true },
  formatPhoneSpaced: { type: Function, required: true },
  formatCent: { type: Function, required: true }
});

const emit = defineEmits([
  'close',
  'backdrop-back',
  'clear-amount',
  'open-keypad',
  'toggle-keypad',
  'set-preset',
  'recharge',
  'request-confirm',
  'cancel-confirm',
  'confirm',
  'update:amountStr',
  'update:summary',
  'update:showKeypad',
  'update:debtAcknowledged'
]);
</script>
