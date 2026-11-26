<template>
  <div class="app-modal-backdrop fixed inset-0 bg-black/60 z-50 flex flex-col justify-end animate-fade-in backdrop-blur-xs" @click.self="onBackdropClick">
    <!-- ======================================================== -->
    <!-- 1. 消费扣款抽屉 (ConsumeModal 经典复刻)                   -->
    <!-- ======================================================== -->
    <form 
      v-if="type === 'consume'"
      class="app-modal-surface consume-sheet bg-white animate-slide-up flex flex-col max-w-lg mx-auto w-full max-h-[92vh] rounded-t-[28px] overflow-hidden shadow-2xl"
      :class="{ 'consume-sheet-debt': isConsumeDebt }"
      role="dialog" 
      aria-modal="true" 
      aria-labelledby="consume-sheet-title"
      @submit.prevent="review"
    >
      <!-- 弹窗手柄 -->
      <div class="w-12 h-1 bg-slate-300 rounded-full mx-auto mt-2 mb-1 shrink-0"></div>

      <header class="consume-header flex items-center justify-between px-4 py-2 border-b border-slate-100 shrink-0">
        <div class="consume-header-copy min-w-0">
          <h2 id="consume-sheet-title" class="modal-title text-base sm:text-lg font-black text-slate-900 flex items-center gap-1.5 m-0 truncate">
            <span>消费扣款</span>
            <span class="text-emerald-800">· {{ currentMember.name }}</span>
          </h2>
          <p class="text-xs text-slate-500 font-medium mt-0.5 m-0">
            {{ BigInt(currentMember.balanceCents) < 0n ? '当前欠款' : '可用余额' }}
            <strong :class="BigInt(currentMember.balanceCents) < 0n ? 'text-rose-600' : 'text-slate-900'">¥{{ displayAbsoluteCents(currentMember.balanceCents) }}</strong>
            {{ currentMember.phone ? ' · 手机尾号 ' + currentMember.phone.slice(-4) : ' · 未留手机号' }}
          </p>
        </div>
        <button type="button" :disabled="busy" @click="requestClose" class="w-11 h-11 rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 flex items-center justify-center text-sm font-bold btn-press shrink-0" aria-label="关闭消费扣款">✕</button>
      </header>

      <p v-if="error" class="mx-3.5 mt-2 p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-bold" role="alert">{{ error }}</p>

      <!-- 醒目金额面板 -->
      <div class="consume-amount-panel mx-3.5 my-2 p-3 rounded-2xl bg-slate-50 border border-slate-200" :class="{ 'bg-rose-50 border-rose-200 text-rose-900': isConsumeDebt }">
        <div class="flex items-center justify-between text-xs font-bold text-slate-500 mb-0.5">
          <span>本次扣款金额</span>
          <button v-if="selectedItems.length" type="button" @click="useManualAmount" class="text-emerald-800" aria-label="改为手输金额">手输金额</button>
        </div>
        <div class="text-3xl sm:text-4xl font-black tracking-tight my-0.5 flex items-baseline gap-1" :class="isConsumeDebt ? 'text-rose-600' : 'text-slate-900'">
          <span class="text-xl sm:text-2xl text-emerald-800">¥</span>
          <span v-if="selectedItems.length" class="consume-amount-display">{{ form.pay || '0.00' }}</span>
          <button v-else type="button" class="consume-amount-display" aria-label="编辑扣款金额" @click="textEditing = false">{{ form.pay || '0.00' }}</button>
          <input class="consume-amount-input" :value="form.pay" inputmode="decimal" aria-label="扣款金额" placeholder="0.00" :readonly="selectedItems.length > 0" @input="form.pay = $event.target.value" />
        </div>
        <div v-if="isConsumeDebt" class="text-xs font-bold text-rose-700 mt-1 flex items-center gap-1">
          <span>⚠️ 余额不足以扣除，将产生欠款记录</span>
        </div>
      </div>

      <!-- 可滚动区域：常用项目与备注 -->
      <div class="consume-content flex-1 overflow-y-auto px-3.5 space-y-2.5">
        <p v-if="currentMember.notes" class="p-2 bg-amber-50 rounded-xl border border-amber-200 text-amber-950 text-xs font-bold leading-relaxed break-words m-0">
          {{ memberNotesLabel }}：{{ currentMember.notes }}
        </p>

        <!-- 常用项目快捷选择 -->
        <div v-if="currentConfiguration?.services?.length" class="space-y-1">
          <div class="flex items-center justify-between text-xs font-bold text-slate-600">
            <span>常用项目</span>
            <span class="text-[11px] text-slate-400">点选添加，可组合服务</span>
          </div>
          <div class="grid grid-cols-3 gap-1.5">
            <button
              v-for="item in currentConfiguration.services"
              :key="item.id"
              type="button"
              class="p-2 rounded-xl border text-left transition-all btn-press"
              :class="selectedItems.some(row => row.serviceId === item.id) ? 'bg-emerald-700 text-white border-emerald-700 shadow-xs' : 'bg-slate-50 text-slate-800 border-slate-200 hover:bg-slate-100'"
              @click="applyServicePreset(item)"
            >
              <div class="text-xs font-bold truncate leading-tight">{{ item.name }}</div>
              <div class="text-xs font-black mt-0.5 tabular-nums">¥{{ displayCents(item.priceCents) }}</div>
            </button>
          </div>
        </div>

        <ul v-if="selectedItems.length" class="sale-items" aria-label="已选服务项目">
          <li v-for="item in selectedItems" :key="item.serviceId">
            <span>{{ item.name }} <small>¥{{ displayCents(item.unitPriceCents) }}</small></span>
            <div class="sale-item-quantity">
              <button type="button" :aria-label="`减少${item.name}`" @click="changeQuantity(item, -1)">−</button>
              <span>{{ item.quantity }}</span>
              <button type="button" :disabled="item.quantity >= 9999" :aria-label="`增加${item.name}`" @click="changeQuantity(item, 1)">＋</button>
            </div>
          </li>
        </ul>
        <label class="block space-y-1">
          <span class="text-xs font-bold text-slate-600">补充说明（选填）</span>
          <input
            v-model.trim="form.note"
            type="text"
            maxlength="512"
            placeholder="补充服务要求，不影响项目金额"
            @focus="textEditing = true"
            class="w-full h-10 px-3 bg-slate-50 border border-slate-200 rounded-xl text-xs sm:text-sm font-semibold text-slate-900 focus:bg-white focus:border-emerald-600 outline-none"
          />
        </label>
      </div>

      <!-- 底部固定触控键盘 -->
      <footer class="consume-footer border-t border-slate-100 bg-white p-2 pb-gesture-safe shrink-0">
        <Keypad
          v-if="!selectedItems.length && !textEditing"
          class="consume-keypad"
          v-model="form.pay"
          :confirm-text="isConsumeDebt ? '核对欠款' : '核对扣款'"
          :theme="isConsumeDebt ? 'danger' : 'primary'"
          :disabled="busy || blocked"
          @confirm="review"
        />
        <button type="submit" class="consume-review book-primary" :class="{ 'consume-review-active': selectedItems.length || textEditing }" :disabled="busy || blocked || !form.pay">{{ isConsumeDebt ? '核对欠款' : '核对扣款' }}</button>
      </footer>
    </form>

    <!-- ======================================================== -->
    <!-- 2. 会员充值抽屉 (RechargeModal 经典复刻)                   -->
    <!-- ======================================================== -->
    <form 
      v-else-if="type === 'recharge' && currentConfiguration"
      class="app-modal-surface recharge-sheet bg-white animate-slide-up flex flex-col max-w-lg mx-auto w-full max-h-[92vh] rounded-t-[28px] overflow-hidden shadow-2xl"
      role="dialog" 
      aria-modal="true" 
      aria-labelledby="recharge-sheet-title"
      @submit.prevent="review"
    >
      <!-- 弹窗手柄 -->
      <div class="w-12 h-1 bg-slate-300 rounded-full mx-auto mt-2 mb-1 shrink-0"></div>

      <header class="recharge-header flex items-center justify-between px-4 py-2 border-b border-slate-100 shrink-0">
        <div class="recharge-header-copy min-w-0">
          <h2 id="recharge-sheet-title" class="modal-title text-base sm:text-lg font-black text-slate-900 flex items-center gap-1.5 m-0 truncate">
            <span>会员充值</span>
            <span class="text-emerald-800">· {{ currentMember.name }}</span>
          </h2>
          <p class="text-xs text-slate-500 font-medium mt-0.5 m-0">
            {{ BigInt(currentMember.balanceCents) < 0n ? '当前欠款' : '可用余额' }}
            <strong :class="BigInt(currentMember.balanceCents) < 0n ? 'text-rose-600' : 'text-slate-900'">¥{{ displayAbsoluteCents(currentMember.balanceCents) }}</strong>
            {{ currentMember.phone ? ' · 手机尾号 ' + currentMember.phone.slice(-4) : ' · 未留手机号' }}
          </p>
        </div>
        <button type="button" :disabled="busy" @click="requestClose" class="w-11 h-11 rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 flex items-center justify-center text-sm font-bold btn-press shrink-0" aria-label="关闭会员充值">✕</button>
      </header>

      <p v-if="error" class="mx-4 mt-2 p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-bold" role="alert">{{ error }}</p>

      <div class="recharge-content flex-1 overflow-y-auto p-4 space-y-3">
        <p v-if="currentMember.notes" class="p-2 bg-amber-50 rounded-xl border border-amber-200 text-amber-950 text-xs font-bold leading-relaxed break-words m-0">
          {{ memberNotesLabel }}：{{ currentMember.notes }}
        </p>
        <div v-if="BigInt(currentMember.balanceCents) < 0n" class="p-2 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-bold">
          充值将优先抵扣欠款，结清后剩余金额转为可用余额。
        </div>

        <!-- 快捷充值套餐 -->
        <div v-if="currentConfiguration.rechargePlans?.length" class="space-y-1.5">
          <div class="flex items-center justify-between text-xs font-bold text-slate-600">
            <span>快捷充值</span>
            <span class="text-[11px] text-slate-400">点选自动计算</span>
          </div>
          <div class="grid grid-cols-3 gap-1.5">
            <button
              v-for="plan in currentConfiguration.rechargePlans"
              :key="plan.id"
              type="button"
              class="p-2.5 rounded-xl border text-left transition-all btn-press"
              :class="form.planId === plan.id ? 'bg-emerald-700 text-white border-emerald-700 shadow-xs' : 'bg-slate-50 text-slate-800 border-slate-200 hover:bg-slate-100'"
              @click="togglePlan(plan)"
            >
              <div class="text-sm font-black tabular-nums">¥{{ displayCents(plan.payCents) }}</div>
              <div
                v-if="currentConfiguration.rechargeSettings?.giftEnabled && BigInt(plan.giftCents || 0) > 0n"
                class="text-[11px] mt-0.5 opacity-90"
              >
                送 ¥{{ displayCents(plan.giftCents) }}
              </div>
            </button>
          </div>
        </div>

        <!-- 实收金额与赠送金额 -->
        <div :class="currentConfiguration.rechargeSettings?.giftEnabled ? 'grid grid-cols-2 gap-2.5' : 'space-y-1'">
          <label class="space-y-1 block">
            <span class="text-xs font-bold text-slate-700">实收（元）</span>
            <div class="recharge-input-box flex items-center bg-slate-50 border border-slate-200 rounded-xl px-3 focus-within:bg-white focus-within:border-emerald-600 focus-within:ring-1 focus-within:ring-emerald-600 transition-colors">
              <span class="text-slate-500 font-bold text-base mr-1.5 select-none shrink-0" aria-hidden="true">¥</span>
              <input
                v-model.trim="form.pay"
                inputmode="decimal"
                :readonly="Boolean(form.planId)"
                placeholder="0.00"
                required
                class="recharge-currency-input flex-1 min-w-0 h-11 bg-transparent border-0 outline-none text-base font-black text-slate-900 focus:ring-0 shadow-none"
              />
            </div>
          </label>

          <label v-if="currentConfiguration.rechargeSettings?.giftEnabled" class="space-y-1 block">
            <span class="text-xs font-bold text-slate-700">赠送（元）</span>
            <div class="recharge-input-box flex items-center bg-slate-50 border border-slate-200 rounded-xl px-3 focus-within:bg-white focus-within:border-emerald-600 focus-within:ring-1 focus-within:ring-emerald-600 transition-colors">
              <span class="text-emerald-700 font-bold text-base mr-1.5 select-none shrink-0" aria-hidden="true">¥</span>
              <input
                :value="giftDisplay"
                @input="form.gift = $event.target.value.trim()"
                aria-label="赠送金额"
                inputmode="decimal"
                :readonly="Boolean(form.planId)"
                placeholder="0.00"
                class="recharge-currency-input flex-1 min-w-0 h-11 bg-transparent border-0 outline-none text-base font-black text-emerald-800 focus:ring-0 shadow-none"
              />
            </div>
          </label>
        </div>

        <p class="recharge-totals" aria-live="polite">到账合计 <strong>¥{{ creditDisplay }}</strong><span v-if="currentConfiguration.rechargeSettings?.giftEnabled"> · {{ form.gift === '' ? '赠送按门店规则自动计算，可手填覆盖' : '赠送使用当前填写金额' }}</span></p>
        <!-- 收款方式 -->
        <div class="space-y-1">
          <span class="text-xs font-bold text-slate-600">收款方式（默认微信，请按实收渠道核对）</span>
          <div class="grid grid-cols-4 gap-1.5">
            <button
              v-for="method in ['微信', '支付宝', '现金', '银行卡']"
              :key="method"
              type="button"
              class="h-10 rounded-xl border text-xs font-bold transition-all btn-press"
              :class="form.payment === method ? 'bg-emerald-700 text-white border-emerald-700 shadow-xs' : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'"
              @click="form.payment = method"
            >
              {{ method }}
            </button>
          </div>
        </div>

        <label class="space-y-1 block">
          <span class="text-xs font-bold text-slate-600">充值备注（选填）</span>
          <input
            v-model.trim="form.note"
            type="text"
            maxlength="512"
            placeholder="补充活动或收款说明"
            class="w-full h-11 px-3.5 bg-slate-50 border border-slate-200 rounded-xl text-xs sm:text-sm font-semibold text-slate-900 focus:bg-white focus:border-emerald-600 outline-none"
          />
        </label>
      </div>

      <!-- 底部核对操作栏 -->
      <footer class="recharge-footer border-t border-slate-100 bg-white p-3.5 pb-gesture-safe shrink-0">
        <button
          type="submit"
          :disabled="busy || blocked || !form.pay"
          class="w-full h-12 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl font-black text-base shadow-md shadow-emerald-500/20 flex items-center justify-center btn-press disabled:opacity-50"
          aria-label="核对金额"
        >
          核对金额
        </button>
      </footer>
    </form>

    <!-- ======================================================== -->
    <!-- 3. 冲正模式 (Reversal)                                   -->
    <!-- ======================================================== -->
    <section 
      v-else-if="type === 'reverse'"
      class="app-modal-surface bg-white animate-slide-up flex flex-col max-w-lg mx-auto w-full p-4 rounded-t-[28px] shadow-2xl"
    >
      <header class="flex items-center justify-between pb-2 border-b border-slate-100">
        <h3 class="text-base font-black text-slate-900 m-0">账务冲正</h3>
        <button type="button" :disabled="busy" @click="requestClose" aria-label="关闭账务冲正" class="w-11 h-11 rounded-full bg-slate-100 text-slate-500 font-bold">✕</button>
      </header>
      <p v-if="error" class="mt-2 p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-bold" role="alert">{{ error }}</p>
      <div class="py-3 space-y-2 text-xs">
        <p>原单号 {{ entry?.id }}，变动 ¥{{ displayCents(entry?.deltaCents) }}。冲正只调整账务，实际退款需另行处理。</p>
        <label class="block space-y-1">
          <span class="font-bold text-slate-700">冲正原因</span>
          <input v-model.trim="form.note" maxlength="1000" placeholder="填写冲正原因" class="w-full h-10 px-3 border border-slate-200 rounded-xl outline-none" />
        </label>
      </div>
      <div class="grid grid-cols-2 gap-2 pt-2">
        <button type="button" :disabled="busy" class="h-11 rounded-xl bg-slate-100 text-slate-700 font-bold text-xs" @click="requestClose">取消</button>
        <button type="button" class="h-11 rounded-xl bg-purple-700 text-white font-black text-xs" :disabled="busy" @click="review">核对冲正</button>
      </div>
    </section>

    <!-- ======================================================== -->
    <!-- 4. 二次防误触金额核对弹窗 (Confirmation Modal)             -->
    <!-- ======================================================== -->
    <div
      v-if="preview"
      class="app-modal-backdrop feedback-backdrop fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fade-in backdrop-blur-xs"
      @click.self="dismissPreview"
    >
      <section 
        class="app-modal-surface feedback-dialog w-full max-w-sm bg-white rounded-3xl p-5 text-center shadow-2xl animate-scale-up"
        :class="{ 'border-2 border-rose-500': isPreviewDebt }"
        role="dialog" 
        aria-modal="true" 
        aria-labelledby="confirm-modal-title"
      >
        <div class="w-12 h-12 rounded-2xl mx-auto flex items-center justify-center font-black text-2xl shadow-xs"
          :class="isPreviewDebt ? 'bg-rose-100 text-rose-600' : 'bg-emerald-100 text-emerald-700'">
          {{ isPreviewDebt ? '⚠️' : '💳' }}
        </div>

        <h3 id="confirm-modal-title" class="mt-3 text-lg font-black text-slate-900 m-0">
          {{ isPreviewDebt ? (type === 'recharge' ? '充值后仍有待结欠款' : '注意：本次交易将产生欠款') : type === 'consume' ? '请核对扣款金额' : type === 'recharge' ? '请核对充值信息' : '请核对冲正信息' }}
        </h3>
        <p class="mt-1 text-xs text-slate-500 m-0">
          {{ isPreviewDebt ? (type === 'recharge' ? '本次充值将优先抵扣欠款，请核对还款金额。' : '确认后将记录欠款账目，请仔细核对。') : '确认后将立即为 ' + currentMember.name + ' 入账。' }}
        </p>

        <div class="feedback-amount mt-3.5 rounded-2xl bg-slate-50 p-3.5 text-left text-xs space-y-2 border border-slate-200">
          <div class="flex justify-between items-center text-slate-600">
            <span>会员姓名</span>
            <strong class="text-slate-900 font-extrabold text-sm">{{ currentMember.name }}</strong>
          </div>
          <div class="flex justify-between items-center text-slate-600">
            <span>手机号码</span>
            <strong class="font-mono text-slate-800">{{ formatPhone(currentMember.phone) || '未留手机号' }}</strong>
          </div>
          <div v-if="type === 'recharge'" class="flex justify-between items-center text-slate-600"><span>收款方式</span><strong>{{ preview.draft.payMethod }}</strong></div>
          <ul v-if="type === 'consume'" class="sale-review-items"><li v-for="(item, index) in preview.draft.items" :key="index">{{ item.name }} × {{ item.quantity }} <strong>¥{{ displayCents(String(BigInt(item.unitPriceCents) * BigInt(item.quantity))) }}</strong></li></ul>
          <div v-if="form.note" class="flex justify-between items-center text-slate-600">
            <span>项目说明</span>
            <strong class="text-slate-800 truncate max-w-[170px]">{{ form.note }}</strong>
          </div>
          <div class="flex justify-between items-center text-slate-600">
            <span>当前余额</span>
            <strong :class="BigInt(currentMember.balanceCents) < 0n ? 'text-rose-600' : 'text-slate-800'">¥{{ displayCents(currentMember.balanceCents) }}</strong>
          </div>
          <div class="pt-2 border-t border-slate-200 flex justify-between items-baseline">
            <span class="text-slate-700 font-bold">{{ type === 'consume' ? '扣款金额' : type === 'recharge' ? '实收金额' : '冲正变动' }}</span>
            <strong class="text-xl font-black tabular-nums" :class="type === 'consume' ? 'text-rose-600' : 'text-emerald-700'">
              ¥{{ displayCents(type === 'recharge' ? preview.draft.actualPayCents : type === 'consume' ? preview.draft.amountCents : preview.financial.deltaCents) }}
            </strong>
          </div>
          <div v-if="type === 'recharge' && currentConfiguration.rechargeSettings?.giftEnabled && BigInt(preview.draft.giftCents || 0) > 0n" class="flex justify-between items-center text-emerald-800 font-semibold">
            <span>赠送额度</span>
            <strong>¥{{ displayCents(preview.draft.giftCents) }}</strong>
          </div>
          <div class="pt-1.5 border-t border-dashed border-slate-200 flex justify-between items-center font-bold">
            <span class="text-slate-600">{{ isPreviewDebt ? '交易后累计欠款' : '交易后可用余额' }}</span>
            <strong class="text-sm font-black tabular-nums" :class="isPreviewDebt ? 'text-rose-600' : 'text-slate-900'">
              ¥{{ displayAbsoluteCents(preview.financial.balanceAfterCents) }}
            </strong>
          </div>
        </div>

        <div v-if="debtConsentRequired" class="mt-3 p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-left">
          <label class="flex items-center gap-2 cursor-pointer">
            <input v-model="form.allowDebt" type="checkbox" :disabled="busy" class="w-4 h-4 rounded text-rose-600 accent-rose-600" />
            <span class="text-xs font-black text-rose-800">我已知晓并同意记录本次欠款</span>
          </label>
        </div>

        <div class="mt-4 grid grid-cols-2 gap-2.5">
          <button 
            type="button" 
            class="h-12 rounded-xl border border-slate-200 text-sm font-bold text-slate-700 hover:bg-slate-50 btn-press"
            :disabled="busy"
            @click="dismissPreview"
          >
            返回修改
          </button>
          <button 
            type="button" 
            :disabled="busy || blocked || (debtConsentRequired && !form.allowDebt)"
            class="h-12 rounded-xl text-white font-black text-sm shadow-md btn-press disabled:opacity-50 flex items-center justify-center gap-1"
            :class="type === 'consume' ? 'bg-gradient-to-r from-rose-600 to-rose-700' : 'bg-gradient-to-r from-emerald-600 to-emerald-700'"
            @click="commit"
          >
            <span v-if="busy">提交中…</span>
            <span v-else>{{ type === 'consume' ? '确认扣款' : type === 'recharge' ? '确认充值' : '确认冲正' }}</span>
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, onScopeDispose, reactive, ref, shallowRef, watch } from 'vue';
import { displayAbsoluteCents, displayCents, suggestedGift, yuanCents } from '../relational-presentation.js';
import { createRecharge, createConsumption, createReversal, applyFinancialCommand } from '../ledger-domain.js';
import { prepareSale } from '../relational-sales.js';
import Keypad from './Keypad.vue';

const props = defineProps({
  workspace: { type: Object, required: true },
  scope: Object,
  type: { type: String, default: 'consume' },
  member: { type: Object, required: true },
  configuration: { type: Object, required: true },
  entry: Object,
  memberNotesLabel: { type: String, default: '会员偏好与备注' }
});

const emit = defineEmits(['close', 'done']);

const currentMember = shallowRef(props.member);
const currentConfiguration = shallowRef(props.configuration);
const busy = ref(false);
const error = ref('');
const preview = ref(null);
const selectedItems = ref([]), textEditing = ref(false);
const resolvedGift = computed(() => {
  if (!currentConfiguration.value?.rechargeSettings?.giftEnabled) return '0';
  if (form.gift !== '') return yuanCents(form.gift);
  return suggestedGift(yuanCents(form.pay || '0'), currentConfiguration.value.rechargeSettings);
});
const giftDisplay = computed(() => { try { return displayCents(resolvedGift.value); } catch { return form.gift; } });
const creditDisplay = computed(() => { try { return displayCents(String(BigInt(yuanCents(form.pay || '0')) + BigInt(resolvedGift.value))); } catch { return '—'; } });

const form = reactive({
  planId: '',
  pay: '',
  gift: '',
  note: '',
  allowDebt: false,
  payment: '微信'
});

let alive = true;
onScopeDispose(() => { alive = false; });
watch(() => [form.planId, form.pay, form.gift, form.note, form.payment, JSON.stringify(selectedItems.value), currentMember.value, currentConfiguration.value], () => {
  preview.value = null;
  form.allowDebt = false;
}, { flush: 'sync' });
watch(preview, value => { if (!value) form.allowDebt = false; }, { flush: 'sync' });

const blocked = computed(() => Boolean(!props.workspace.state.book || props.workspace.state.pending || props.workspace.state.pendingError));
const transactionError = cause => (cause?.message || '操作未完成，请重试。').replace('超出 BIGINT 范围', '超出支持的金额上限，请核对本次金额。');

const isConsumeDebt = computed(() => {
  if (props.type !== 'consume' || !form.pay) return false;
  try {
    const payCents = BigInt(yuanCents(form.pay, { positive: true }));
    const balanceCents = BigInt(currentMember.value.balanceCents);
    return balanceCents - payCents < 0n;
  } catch {
    return false;
  }
});

const isPreviewDebt = computed(() => {
  if (!preview.value) return false;
  return BigInt(preview.value.financial.balanceAfterCents) < 0n;
});
const debtConsentRequired = computed(() => props.type !== 'recharge' && isPreviewDebt.value);

const formatPhone = value => {
  if (!value) return '';
  const digits = value.replace(/\D/g, '');
  if (digits.length === 11) return digits.replace(/(\d{3})(\d{4})(\d{4})/, '$1 $2 $3');
  return value;
};

function useManualAmount() { selectedItems.value = []; form.pay = ''; }
function sumItems() {
  form.pay = selectedItems.value.length ? displayCents(String(selectedItems.value.reduce((sum, row) => sum + BigInt(row.unitPriceCents) * BigInt(row.quantity), 0n))) : '';
}
function changeQuantity(item, delta) {
  item.quantity = Math.max(0, Math.min(9999, item.quantity + delta));
  selectedItems.value = selectedItems.value.filter(row => row.quantity > 0);
  sumItems();
}
function applyServicePreset(item) {
  const row = selectedItems.value.find(row => row.serviceId === item.id);
  if (row) changeQuantity(row, 1);
  else if (selectedItems.value.length < 100) {
    selectedItems.value.push({ serviceId: item.id, name: item.name, unitPriceCents: item.priceCents, quantity: 1 });
    sumItems();
  }
}

function togglePlan(plan) {
  if (form.planId === plan.id) {
    form.planId = '';
    form.pay = '';
    form.gift = '';
  } else {
    form.planId = plan.id;
    form.pay = displayCents(plan.payCents);
    form.gift = currentConfiguration.value?.rechargeSettings?.giftEnabled ? displayCents(plan.giftCents) : '';
  }
}

function onBackdropClick() {
  if (busy.value) return;
  if (preview.value) {
    preview.value = null;
  } else {
    emit('close');
  }
}
function requestClose() { if (!busy.value) emit('close'); }
function dismissPreview() { if (!busy.value) preview.value = null; }

function goBack() {
  if (busy.value) return;
  if (preview.value) {
    preview.value = null;
    form.allowDebt = false;
  } else {
    emit('close');
  }
}

defineExpose({ goBack });

function review() {
  if (busy.value || blocked.value) return;
  error.value = '';
  preview.value = null;
  form.allowDebt = false;
  try {
    const { type, entry } = props, member = currentMember.value, configuration = currentConfiguration.value;
    if (type !== 'reverse' && member.archivedAt) throw new Error('会员已归档，请重新打开档案核对。');
    const base = { memberId: member.id, type, expectedAccountVersion: member.accountVersion, expectedProfileVersion: member.version };
    let draft, financial;

    if (type === 'recharge') {
      if (!form.pay) throw new Error('请输入充值金额');
      const actualPayCents = yuanCents(form.pay, { positive: true });
      const giftCents = resolvedGift.value;
      draft = {
        ...base,
        actualPayCents,
        giftCents,
        configurationVersion: configuration.version,
        remark: form.note,
        ...(form.planId ? { planId: form.planId } : {}),
        payMethod: form.payment
      };
      financial = applyFinancialCommand(member.balanceCents, createRecharge(draft));
    } else if (type === 'consume') {
      if (!form.pay) throw new Error('请输入扣款金额');
      const unitPriceCents = yuanCents(form.pay, { positive: true });
      const items = selectedItems.value.length ? selectedItems.value.map(row => ({ ...row })) : [{ name: '自定义消费', unitPriceCents, quantity: 1 }];
      const serviceName = items.map(row => row.name + (row.quantity > 1 ? ' ×' + row.quantity : '')).join('、');
      draft = {
        ...base,
        amountCents: unitPriceCents,
        items,
        itemsSummary: serviceName.slice(0, 128),
        configurationVersion: configuration.version,
        remark: form.note,
        allowDebt: false
      };
      // Calculate the hypothetical balance without granting debt consent.
      financial = applyFinancialCommand(member.balanceCents, createConsumption({ ...draft, allowDebt: true }));
    } else {
      draft = { ...base, originalEntryId: entry.id, reason: form.note || '店主手工冲正', allowDebt: false };
      financial = createReversal({ originalKind: entry.type, originalDeltaCents: entry.deltaCents, currentBalanceCents: member.balanceCents, allowDebt: true });
    }

    prepareSale(draft, configuration);
    preview.value = { draft, financial };
  } catch (cause) {
    error.value = transactionError(cause);
  }
}

async function commit() {
  if (!preview.value || busy.value || blocked.value || (debtConsentRequired.value && !form.allowDebt)) return;
  const draft = { ...preview.value.draft, ...(props.type !== 'recharge' ? { allowDebt: form.allowDebt === true } : {}) };
  busy.value = true;
  error.value = '';
  try {
    const result = await props.workspace.submit('command', draft, props.scope);
    if (alive) emit('done', result, draft, currentMember.value);
  } catch (cause) {
    if (!alive) return;
    preview.value = null;
    form.allowDebt = false;
    try {
      if (['MEMBER_VERSION_CHANGED', 'ACCOUNT_VERSION_CHANGED', 'WRITE_MEMBER_ARCHIVED', 'MEMBER_ARCHIVED'].includes(cause.code)) {
        const member = await props.workspace.read('getMember', currentMember.value.id);
        if (alive) {
          currentMember.value = member;
          error.value = '资料或余额已变化，请核对最新资料并重新确认。原操作已拒绝。原请求没有入账。';
        }
      } else if (cause.code === 'CONFIGURATION_VERSION_CHANGED') {
        const configuration = await props.workspace.read('getConfiguration');
        if (alive) {
          currentConfiguration.value = configuration;
          if (form.planId) { form.planId = ''; form.pay = ''; }
          form.gift = '';
          selectedItems.value = [];
          form.pay = '';
          error.value = '成交规则已变化，请按最新价格和赠送规则重新确认。';
        }
      } else {
        error.value = transactionError(cause);
      }
    } catch (refreshError) {
      if (alive) error.value = transactionError(cause) + '。未能读取最新数据：' + refreshError.message;
    }
  } finally {
    busy.value = false;
  }
}
</script>
