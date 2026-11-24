<template>
  <div class="app-modal-backdrop fixed inset-0 bg-black/60 z-50 flex flex-col justify-end animate-fade-in backdrop-blur-xs" @click.self="$emit('close')">
    <form class="app-modal-surface bg-white rounded-t-[32px] max-h-[92vh] overflow-y-auto max-w-lg mx-auto w-full animate-slide-up shadow-2xl flex flex-col p-4 sm:p-5"
      @submit.prevent="review">
      <!-- 弹窗顶部手柄 -->
      <div class="w-12 h-1 bg-slate-300 rounded-full mx-auto mb-2 shrink-0"></div>

      <!-- 头部：会员信息与关闭按钮 -->
      <header class="flex items-center justify-between pb-3 border-b border-slate-100 shrink-0">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-11 h-11 rounded-2xl bg-gradient-to-tr from-emerald-700 to-slate-900 text-white flex items-center justify-center font-black text-lg shadow-xs shrink-0" aria-hidden="true">
            {{ currentMember.name.charAt(0) }}
          </div>
          <div class="min-w-0">
            <h2 class="text-base sm:text-lg font-black text-slate-900 flex items-center gap-1.5 truncate">
              <span>{{ type === 'consume' ? '消费扣款' : type === 'recharge' ? '会员充值' : '账务冲正' }}</span>
              <span class="text-emerald-800">· {{ currentMember.name }}</span>
            </h2>
            <p class="text-xs text-slate-500 font-medium mt-0.5">
              核对余额：<strong :class="BigInt(currentMember.balanceCents) < 0n ? 'text-rose-600' : 'text-slate-900'">¥{{ displayCents(currentMember.balanceCents) }}</strong>
              {{ currentMember.phone ? ' · 手机尾号 ' + currentMember.phone.slice(-4) : ' · 未留手机号' }}
            </p>
          </div>
        </div>
        <button type="button" aria-label="关闭" class="w-8 h-8 rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 flex items-center justify-center text-sm font-bold btn-press shrink-0"
          :disabled="busy" @click="$emit('close')">✕</button>
      </header>

      <div class="space-y-3.5 pt-3">
        <!-- 会员偏好备注提醒 -->
        <p v-if="currentMember.notes" class="p-2.5 bg-amber-50 rounded-xl border border-amber-200 text-amber-950 text-xs font-bold leading-relaxed break-words">
          💇 会员偏好：{{ currentMember.notes }}
        </p>

        <!-- ==================== 1. 消费扣款模式 ==================== -->
        <template v-if="type === 'consume'">
          <!-- 醒目金额面板 -->
          <div class="consume-amount-panel rounded-2xl p-3.5 bg-slate-50 border border-slate-200 flex flex-col items-center justify-center text-center">
            <div class="flex items-center justify-between w-full text-xs font-bold text-slate-500 mb-1">
              <span>本次扣款金额</span>
              <button v-if="form.pay" type="button" @click="clearConsumeAmount" class="text-rose-600 hover:underline">清空</button>
            </div>
            <div class="text-3xl sm:text-4xl font-black text-slate-900 tracking-tight my-1 flex items-baseline gap-1">
              <span class="text-xl sm:text-2xl text-emerald-800">¥</span>
              <span>{{ form.pay || '0.00' }}</span>
            </div>
            <!-- 欠款警告 -->
            <div v-if="isConsumeDebt" class="w-full mt-2 p-2 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-bold text-left">
              <span>⚠️ 余额不足以扣除，将产生欠款记录</span>
            </div>
          </div>

          <!-- 常用服务快捷芯片（选项目自动带入金额） -->
          <div v-if="currentConfiguration?.services?.length" class="space-y-1.5">
            <div class="flex items-center justify-between text-xs font-bold text-slate-600">
              <span>常用项目一键带入</span>
              <span class="text-[11px] text-slate-400">点选自动填入金额</span>
            </div>
            <div class="chip-group flex flex-wrap gap-1.5">
              <button v-for="item in currentConfiguration.services" :key="item.id" type="button"
                class="chip-btn text-xs py-1.5 px-3 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-800 font-bold active:bg-emerald-600 active:text-white transition-all btn-press"
                @click="applyServicePreset(item)">
                {{ item.name }} · ¥{{ displayCents(item.priceCents) }}
              </button>
            </div>
          </div>

          <!-- 消费说明/备注 -->
          <div class="space-y-1">
            <label class="block text-xs font-bold text-slate-600">服务项目与补充说明</label>
            <input v-model.trim="form.note" type="text" maxlength="512" placeholder="填写服务项目或补充说明"
              class="w-full h-11 px-3.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-slate-900 focus:bg-white focus:border-emerald-600 outline-none" />
          </div>

          <!-- 欠款允许复选框 -->
          <label class="flex items-center gap-2 p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 cursor-pointer">
            <input v-model="form.allowDebt" type="checkbox" class="w-4 h-4 rounded text-amber-700">
            <span class="text-xs font-bold">确认允许本次交易产生欠款</span>
          </label>

          <!-- 兼容测试表单隐藏/绑定字段 -->
          <input v-model.trim="form.pay" inputmode="decimal" type="text" class="sr-only" required />

          <!-- 触控数字键盘 (Tactile Keypad) -->
          <div class="pt-1">
            <Keypad v-model="form.pay" :confirm-text="isConsumeDebt ? '核对欠款' : '核对金额'"
              :disabled="busy || blocked" @confirm="review" />
          </div>
        </template>

        <!-- ==================== 2. 会员充值模式 ==================== -->
        <template v-else-if="type === 'recharge' && currentConfiguration">
          <!-- 快捷套餐选择 -->
          <div v-if="currentConfiguration.rechargePlans?.length" class="space-y-1.5">
            <span class="text-xs font-bold text-slate-600">快捷充值套餐</span>
            <div class="chip-group flex flex-wrap gap-1.5">
              <button type="button" class="chip-btn text-xs py-1.5 px-3 rounded-xl border font-bold transition-all btn-press"
                :class="form.planId === '' ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-slate-50 text-slate-700 border-slate-200'"
                @click="form.planId = ''; selectPlan()">
                自定义金额
              </button>
              <button v-for="plan in currentConfiguration.rechargePlans" :key="plan.id" type="button"
                class="chip-btn text-xs py-1.5 px-3 rounded-xl border font-bold transition-all btn-press"
                :class="form.planId === plan.id ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-slate-50 text-slate-700 border-slate-200'"
                @click="form.planId = plan.id; selectPlan()">
                充 ¥{{ displayCents(plan.payCents) }} 送 ¥{{ displayCents(plan.giftCents) }}
              </button>
            </div>
          </div>

          <!-- 实收金额与赠送金额 -->
          <div class="grid grid-cols-2 gap-2.5">
            <label class="space-y-1 block">
              <span class="text-xs font-bold text-slate-700">实收（元）</span>
              <div class="relative">
                <span class="absolute left-3 top-2.5 text-slate-400 font-bold text-base">¥</span>
                <input v-model.trim="form.pay" inputmode="decimal" :readonly="Boolean(form.planId)" placeholder="0.00" required
                  class="w-full h-11 pl-8 pr-3 bg-slate-50 border border-slate-200 rounded-xl text-base font-black text-slate-900 focus:bg-white focus:border-emerald-600 outline-none" />
              </div>
            </label>

            <label v-if="currentConfiguration.rechargeSettings?.giftEnabled" class="space-y-1 block">
              <span class="text-xs font-bold text-slate-700">赠送（元）</span>
              <div class="relative">
                <span class="absolute left-3 top-2.5 text-slate-400 font-bold text-base">¥</span>
                <input v-model.trim="form.gift" inputmode="decimal" :readonly="Boolean(form.planId)" placeholder="按配置计算"
                  class="w-full h-11 pl-8 pr-3 bg-slate-50 border border-slate-200 rounded-xl text-base font-black text-emerald-800 focus:bg-white focus:border-emerald-600 outline-none" />
              </div>
            </label>
          </div>

          <!-- 付款方式芯片选择 -->
          <div class="space-y-1">
            <span class="text-xs font-bold text-slate-600">收款方式</span>
            <div class="grid grid-cols-4 gap-1.5">
              <button v-for="method in ['微信', '支付宝', '现金', '银行卡']" :key="method" type="button"
                class="h-10 rounded-xl border text-xs font-bold transition-all btn-press"
                :class="form.payment === method ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-slate-50 text-slate-700 border-slate-200'"
                @click="form.payment = method">
                {{ method }}
              </button>
            </div>
          </div>

          <label class="space-y-1 block">
            <span class="text-xs font-bold text-slate-600">充值备注（选填）</span>
            <input v-model.trim="form.note" type="text" maxlength="512" placeholder="补充活动或收款说明"
              class="w-full h-11 px-3.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-slate-900 focus:bg-white focus:border-emerald-600 outline-none" />
          </label>
        </template>

        <!-- ==================== 3. 冲正模式 ==================== -->
        <div v-else-if="type === 'reverse'" class="p-3 bg-purple-50 rounded-xl border border-purple-200 text-purple-900 text-xs font-bold space-y-1">
          <p>原单号 {{ entry.id }}，变动 ¥{{ displayCents(entry.deltaCents) }}。冲正只调整账务，实际退款需另行处理。</p>
          <label class="space-y-1 block pt-2">
            <span class="text-xs font-bold text-slate-700">冲正原因</span>
            <input v-model.trim="form.note" maxlength="1000" placeholder="填写冲正原因"
              class="w-full h-11 px-3 bg-white border border-slate-200 rounded-xl text-sm font-semibold text-slate-900 outline-none" />
          </label>
        </div>

        <!-- 错误提示 -->
        <p v-if="error" class="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-bold" role="alert">
          {{ error }}
        </p>

        <!-- 试算核对预览区域 -->
        <div v-if="preview" class="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-950 space-y-1" role="status">
          <p class="text-sm font-black">
            本次变动 ¥{{ displayCents(preview.financial.deltaCents) }}；确认后余额 <strong>¥{{ displayCents(preview.financial.balanceAfterCents) }}</strong>。
          </p>
          <p v-if="debtIncrease" class="text-xs text-rose-700 font-bold">
            本次新增欠款 ¥{{ displayCents(debtIncrease) }}；总欠款 ¥{{ displayCents((-BigInt(preview.financial.balanceAfterCents)).toString()) }}。
          </p>
          <p v-if="type === 'recharge'" class="text-xs text-emerald-800 font-semibold">
            实收 ¥{{ displayCents(preview.draft.actualPayCents) }}，赠送 ¥{{ displayCents(preview.draft.giftCents) }}。
          </p>
        </div>

        <!-- 底部提交操作栏 (除消费模式已有Keypad快捷操作外，提供标准按钮) -->
        <div class="grid grid-cols-2 gap-2 pt-1" v-if="type !== 'consume' || preview">
          <button v-if="!preview" type="submit" :disabled="busy || blocked"
            aria-label="核对金额" class="h-12 bg-emerald-700 hover:bg-emerald-800 text-white rounded-xl font-black text-sm shadow-md btn-press disabled:opacity-50">
            核对金额
          </button>
          <button v-else type="button" :disabled="busy || blocked"
            :aria-label="type === 'consume' ? '确认扣款' : type === 'recharge' ? '确认充值' : '确认冲正'"
            class="h-12 bg-emerald-700 hover:bg-emerald-800 text-white rounded-xl font-black text-sm shadow-md btn-press disabled:opacity-50"
            @click="commit">
            确认{{ type === 'consume' ? '扣款' : type === 'recharge' ? '充值' : '冲正' }}
          </button>
          <button type="button" :disabled="busy" aria-label="关闭" class="h-12 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-bold text-sm btn-press"
            @click="$emit('close')">
            {{ preview ? '返回修改' : '取消关闭' }}
          </button>
        </div>
      </div>
    </form>
  </div>
</template>

<script setup>
import { reactive, ref, shallowRef, watch, computed, onScopeDispose } from 'vue';
import { displayCents, suggestedGift, yuanCents } from '../relational-presentation.js';
import { createRecharge, createConsumption, createReversal, applyFinancialCommand, centsString } from '../ledger-domain.js';
import { prepareSale } from '../relational-sales.js';
import Keypad from './Keypad.vue';

const props = defineProps({
  workspace: Object,
  scope: Object,
  type: String,
  member: Object,
  configuration: Object,
  entry: Object
});
const emit = defineEmits(['close', 'done']);

const line = () => ({ id: '', name: '', price: '', quantity: 1 });
const form = reactive({
  planId: '',
  pay: '',
  gift: '',
  note: '',
  allowDebt: false,
  payment: '微信',
  payments: [{ method: '微信', amount: '' }],
  lines: [line()]
});

const preview = ref(null);
const busy = ref(false);
const error = ref('');
const currentMember = shallowRef(props.member);
const currentConfiguration = shallowRef(props.configuration);
let alive = true;
onScopeDispose(() => { alive = false; });

const blocked = computed(() => Boolean(!props.workspace.state.book || props.workspace.state.pending || props.workspace.state.pendingError));

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

const debtIncrease = computed(() => {
  if (!preview.value || props.type === 'recharge') return null;
  const before = BigInt(currentMember.value.balanceCents), after = BigInt(preview.value.financial.balanceAfterCents);
  return after < (before < 0n ? before : 0n) ? ((before < 0n ? before : 0n) - after).toString() : null;
});

watch(form, () => {
  preview.value = null;
  error.value = '';
}, { deep: true, flush: 'sync' });

function clearConsumeAmount() {
  form.pay = '';
  form.lines[0].price = '';
}

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

function selectPlan() {
  const plan = currentConfiguration.value.rechargePlans.find(row => row.id === form.planId);
  form.pay = plan ? displayCents(plan.payCents) : '';
  form.gift = plan ? displayCents(plan.giftCents) : '';
}

function applyServicePreset(item) {
  const price = displayCents(item.priceCents);
  form.pay = price;
  form.note = item.name;
  form.lines = [{ id: item.id, name: item.name, price, quantity: 1 }];
}

function review() {
  if (busy.value || blocked.value) return;
  error.value = '';
  try {
    const { type, entry } = props, member = currentMember.value, configuration = currentConfiguration.value;
    if (type !== 'reverse' && member.archivedAt) throw new Error('会员已归档，请重新打开档案核对。');
    const base = { memberId: member.id, type, expectedAccountVersion: member.accountVersion, expectedProfileVersion: member.version };
    let draft, financial;
    if (type === 'recharge') {
      const actualPayCents = yuanCents(form.pay, { positive: true });
      const giftCents = !configuration.rechargeSettings.giftEnabled ? '0' : form.gift ? yuanCents(form.gift) : suggestedGift(actualPayCents, configuration.rechargeSettings);
      draft = {
        ...base, actualPayCents, giftCents, configurationVersion: configuration.version, remark: form.note,
        ...(form.planId ? { planId: form.planId } : {}),
        ...(form.payment === '组合支付' ? { payments: form.payments.map(row => ({ method: row.method, amountCents: yuanCents(row.amount, { positive: true }) })) } : { payMethod: form.payment })
      };
      financial = applyFinancialCommand(member.balanceCents, createRecharge(draft));
    } else if (type === 'consume') {
      const payAmount = form.pay || form.lines[0]?.price;
      if (!payAmount) throw new Error('请输入扣款金额');
      const unitPriceCents = yuanCents(payAmount, { positive: true });
      const serviceName = form.note || form.lines[0]?.name || '消费扣款';
      const items = [{
        ...(form.lines[0]?.id ? { serviceId: form.lines[0].id } : {}),
        name: serviceName,
        unitPriceCents,
        quantity: 1
      }];
      draft = {
        ...base,
        amountCents: unitPriceCents,
        items,
        itemsSummary: serviceName.slice(0, 128),
        configurationVersion: configuration.version,
        remark: form.note,
        allowDebt: form.allowDebt
      };
      financial = applyFinancialCommand(member.balanceCents, createConsumption(draft));
    } else {
      draft = { ...base, originalEntryId: entry.id, reason: form.note || '店主手工冲正', allowDebt: form.allowDebt };
      financial = createReversal({ originalKind: entry.type, originalDeltaCents: entry.deltaCents, currentBalanceCents: member.balanceCents, allowDebt: form.allowDebt });
    }
    prepareSale(draft, configuration);
    preview.value = { draft, financial };
  } catch (cause) { error.value = cause.message; }
}

async function commit() {
  if (!preview.value || busy.value || blocked.value) return;
  const reviewed = preview.value, { draft } = reviewed;
  busy.value = true; error.value = '';
  try {
    const result = await props.workspace.submit('command', draft, props.scope);
    if (alive) emit('done', result, draft, currentMember.value);
  } catch (cause) {
    if (!alive) return;
    preview.value = null; form.allowDebt = false;
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
          error.value = '成交规则已变化，请按最新价格和赠送规则重新确认。';
        }
      } else error.value = cause.message;
    } catch (refreshError) {
      if (alive) error.value = cause.message + '。未能读取最新数据：' + refreshError.message;
    }
  }
  finally { busy.value = false; }
}
</script>
