<template>
  <div v-if="member">
    <!-- 充值抽屉 -->
    <div 
      class="app-modal-backdrop recharge-backdrop fixed inset-0 bg-black/60 z-50 flex flex-col justify-end animate-fade-in backdrop-blur-xs"
      @click.self="emit('close')"
    >
      <section class="app-modal-surface recharge-sheet bg-white animate-slide-up" role="dialog" aria-modal="true" aria-labelledby="recharge-sheet-title">
        <header class="recharge-header">
          <div class="recharge-header-copy">
            <h2 id="recharge-sheet-title" class="modal-title">会员充值 <span>{{ member.name }}</span></h2>
            <p>{{ member.balance < 0 ? '当前欠款' : '可用余额' }}
              <strong :class="{ 'balance-debt': member.balance < 0 }">¥{{ formatCent(Math.abs(member.balance)) }}</strong>
            </p>
          </div>
          <button type="button" @click="emit('close')" class="consume-close" aria-label="关闭会员充值">✕</button>
        </header>

        <div class="recharge-content">
          <div v-if="member.balance < 0" class="recharge-debt-note">充值先抵扣欠款，结清后剩余金额转为可用余额。</div>
          <div class="recharge-section-heading"><h3>快捷充值</h3><span>也可直接输入金额</span></div>
          <div class="recharge-plans">
            <button v-for="plan in plans" :key="plan.pay + '_' + plan.gift" type="button" @click="emit('apply-plan', plan)"
              :aria-pressed="Number(form.actualPay) === plan.pay" :aria-label="'充值' + plan.pay + '元'">
              <strong>¥{{ plan.pay }}</strong>
              <span v-if="settings.giftEnabled">送 ¥{{ formatCent(rechargeGiftCent(plan.pay, settings)) }}</span>
            </button>
          </div>

          <div class="recharge-amounts">
            <label for="recharge-pay">实收充值金额 <span>元</span></label>
            <div class="recharge-pay-input"><span aria-hidden="true">¥</span>
              <input id="recharge-pay" v-model.number="form.actualPay" @input="emit('update-gift')" type="number" inputmode="decimal"
                min="0" step="0.01" placeholder="0.00" />
            </div>
            <div v-if="settings.giftEnabled" class="recharge-gift-field">
              <div class="recharge-gift-heading"><label for="recharge-gift">赠送金额 <span>元</span></label><span>按 {{ settings.giftRate }}% 自动计算，可调整</span></div>
              <input id="recharge-gift" v-model.number="form.giftAmount" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00" />
            </div>
          </div>

          <div class="recharge-channel-heading"><h3>收款渠道</h3><span>选填 · 再点取消</span></div>
          <div class="recharge-channels" role="group" aria-label="收款渠道（选填）">
            <button v-for="channel in channels" :key="channel.value" type="button"
              @click="form.payMethod = form.payMethod === channel.value ? '' : channel.value"
              :aria-pressed="form.payMethod === channel.value">{{ channel.label }}</button>
          </div>
          <label class="recharge-remark" for="recharge-remark">充值备注 <span>选填</span>
            <input id="recharge-remark" v-model="form.remark" type="text" maxlength="4096" placeholder="填写活动或收款说明" />
          </label>
        </div>

        <footer class="recharge-footer">
          <div class="recharge-credit-preview"><span>实际到账</span><strong>¥{{ formatCent(creditCent) }}</strong></div>
          <p v-if="canSubmit" class="recharge-balance-preview" :class="{ 'balance-debt': balanceAfter < 0 }">
            <template v-if="member.balance < 0">本次抵扣欠款 ¥{{ formatCent(Math.min(-member.balance, creditCent)) }} · </template>
            {{ balanceAfter < 0 ? '仍欠款' : '充值后余额' }} ¥{{ formatCent(Math.abs(balanceAfter)) }}
          </p>
          <button type="button" @click="emit('request-confirm')"
            :disabled="!canSubmit || isSubmitting || !canWrite('recharge')" class="recharge-review-button">核对充值信息</button>
        </footer>
      </section>
    </div>

    <!-- 充值金额确认框 -->
    <div
      v-if="confirmation"
      class="app-modal-backdrop feedback-backdrop fixed inset-0 z-[60] flex items-center justify-center p-5 animate-fade-in"
      @click.self="emit('cancel-confirm')"
    >
      <section class="app-modal-surface feedback-dialog recharge-confirm-dialog w-full max-w-sm bg-white text-center shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="recharge-confirm-title">
        <div class="feedback-icon feedback-icon-success mx-auto">¥</div>
        <h2 id="recharge-confirm-title" class="mt-4 text-2xl font-black text-slate-900">请再核对一次</h2>
        <p class="mt-2 text-base text-slate-700">确认后将立即为 {{ confirmation.memberName }} 充值入账。</p>
        <p class="mt-1 text-sm text-slate-600">手机号：{{ confirmation.memberPhone }}</p>
        <div class="feedback-amount mt-5 rounded-xl px-4 py-4 text-left">
          <div class="flex justify-between gap-3 text-base"><span>实收金额</span><strong>¥{{ confirmation.actualPay.toFixed(2) }}</strong></div>
          <div v-if="confirmation.rechargeSettings.giftEnabled" class="mt-2 flex justify-between gap-3 text-base"><span>赠送额度</span><strong>¥{{ confirmation.giftAmount.toFixed(2) }}</strong></div>
          <div class="mt-3 border-t border-emerald-200 pt-3 flex justify-between gap-3 text-lg font-black text-emerald-800"><span>总到账</span><strong>¥{{ (confirmation.actualPay + confirmation.giftAmount).toFixed(2) }}</strong></div>
          <div v-if="confirmation.payMethod" class="mt-2 text-sm text-slate-600">收款方式：{{ confirmation.payMethod }}</div>
          <div v-if="confirmation.currentBalance < 0" class="recharge-debt-preview">
            <div>本次抵扣欠款 <strong>¥{{ formatCent(confirmation.debtRepaid) }}</strong></div>
            <div :class="{ 'balance-debt': confirmation.balanceAfter < 0 }">{{ confirmation.balanceAfter < 0 ? '充值后仍欠款' : '充值后可用余额' }} <strong>¥{{ formatCent(Math.abs(confirmation.balanceAfter)) }}</strong></div>
          </div>
        </div>
        <div class="mt-6 grid grid-cols-2 gap-3">
          <button @click="emit('cancel-confirm')" class="h-14 rounded-xl border-2 border-slate-300 text-base font-bold text-slate-700 btn-press">返回修改</button>
          <button @click="emit('confirm')" :disabled="isSubmitting || !canWrite('recharge')" class="h-14 rounded-xl bg-emerald-700 text-base font-black text-white btn-press disabled:opacity-60">确认充值</button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { rechargeGiftCent } from '../recharge-settings.js';

defineProps({
  member: { type: Object, default: null },
  form: { type: Object, required: true },
  plans: { type: Array, default: () => [] },
  settings: { type: Object, default: () => ({ giftEnabled: false, giftRate: 0 }) },
  channels: { type: Array, default: () => [] },
  creditCent: { type: Number, default: 0 },
  balanceAfter: { type: Number, default: 0 },
  canSubmit: { type: Boolean, default: false },
  isSubmitting: { type: Boolean, default: false },
  confirmation: { type: Object, default: null },
  canWrite: { type: Function, default: () => true },
  formatCent: { type: Function, required: true }
});

const emit = defineEmits([
  'close',
  'apply-plan',
  'update-gift',
  'request-confirm',
  'cancel-confirm',
  'confirm'
]);
</script>
