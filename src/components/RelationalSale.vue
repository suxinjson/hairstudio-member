<template>
  <div class="app-sheet-backdrop" @click.self="$emit('close')">
    <form class="book-panel book-stack app-sheet-surface" @submit.prevent="review">
      <!-- 头部：会员信息与交易类型 -->
      <div class="book-actions book-between" style="border-bottom: 1px solid #f1f5f9; padding-bottom: 0.75rem;">
        <div style="display: flex; align-items: center; gap: 0.75rem;">
          <div class="customer-avatar" aria-hidden="true" style="width: 44px; height: 44px;">{{ currentMember.name.charAt(0) }}</div>
          <div>
            <h3 style="margin: 0; font-size: 1.15rem; font-weight: 800; color: #1e293b;">
              {{ type === 'consume' ? '消费' : type === 'recharge' ? '充值' : '账务冲正' }} · {{ currentMember.name }}
            </h3>
            <p style="margin: 0.15rem 0 0; font-size: 0.8125rem; color: #64748b;">
              核对余额：¥{{ displayCents(currentMember.balanceCents) }}{{ currentMember.phone ? ' · 手机尾号 ' + currentMember.phone.slice(-4) : ' · 未留手机号' }}
            </p>
          </div>
        </div>
        <button type="button" aria-label="关闭" class="book-btn" :disabled="busy" @click="$emit('close')" style="min-height: 2.25rem; padding: 0.25rem 0.625rem;">✕</button>
      </div>

      <p v-if="currentMember.notes" class="book-break customer-note-snippet" style="font-size: 0.8125rem;">备注：{{ currentMember.notes }}</p>

      <!-- 充值视图 -->
      <template v-if="type === 'recharge' && currentConfiguration">
        <!-- 充值套餐快捷芯片 -->
        <div v-if="currentConfiguration.rechargePlans.length" style="display: flex; flex-direction: column; gap: 0.35rem;">
          <span style="font-size: 0.8125rem; font-weight: 600; color: #475569;">快捷套餐</span>
          <div class="chip-group">
            <button type="button" class="chip-btn" :aria-pressed="form.planId === ''" @click="form.planId = ''; selectPlan()">
              自定义
            </button>
            <button v-for="plan in currentConfiguration.rechargePlans" :key="plan.id" type="button" class="chip-btn"
              :aria-pressed="form.planId === plan.id" @click="form.planId = plan.id; selectPlan()">
              充 ¥{{ displayCents(plan.payCents) }} 送 ¥{{ displayCents(plan.giftCents) }}
            </button>
          </div>
          <!-- 兼容测试 select -->
          <label style="display: none;">充值套餐
            <select v-model="form.planId" @change="selectPlan">
              <option value="">自定义</option>
              <option v-for="plan in currentConfiguration.rechargePlans" :key="plan.id" :value="plan.id">
                充 ¥{{ displayCents(plan.payCents) }}，送 ¥{{ displayCents(plan.giftCents) }}
              </option>
            </select>
          </label>
        </div>

        <div class="book-fields">
          <label>实收（元）
            <input v-model.trim="form.pay" inputmode="decimal" :readonly="Boolean(form.planId)" placeholder="0.00" required>
          </label>
          <label v-if="currentConfiguration.rechargeSettings.giftEnabled">赠送（元）
            <input v-model.trim="form.gift" inputmode="decimal" :readonly="Boolean(form.planId)" placeholder="按配置建议">
          </label>
          <label>付款方式
            <select v-model="form.payment">
              <option>微信</option>
              <option>支付宝</option>
              <option>现金</option>
              <option>银行卡</option>
              <option>其他</option>
              <option>组合支付</option>
            </select>
          </label>
        </div>

        <div v-if="form.payment === '组合支付'" class="book-stack" style="background: #f8fafc; padding: 0.75rem; border-radius: 0.75rem; border: 1px solid #e2e8f0;">
          <div v-for="(row, index) in form.payments" :key="index" class="book-fields">
            <label>付款方式
              <select v-model="row.method"><option>微信</option><option>支付宝</option><option>现金</option><option>银行卡</option><option>其他</option></select>
            </label>
            <label>付款金额（元）<input v-model.trim="row.amount" inputmode="decimal" required></label>
            <button type="button" class="book-btn" @click="form.payments.splice(index, 1)" :disabled="form.payments.length === 1">移除</button>
          </div>
          <button type="button" class="book-btn" @click="form.payments.push({ method: '现金', amount: '' })" :disabled="form.payments.length === 16">添加付款方式</button>
        </div>
      </template>

      <!-- 消费视图 -->
      <template v-else-if="type === 'consume' && currentConfiguration">
        <!-- 常用服务快捷选择 -->
        <div v-if="currentConfiguration.services.length" style="display: flex; flex-direction: column; gap: 0.35rem;">
          <span style="font-size: 0.8125rem; font-weight: 600; color: #475569;">常用项目一键带入</span>
          <div class="chip-group">
            <button v-for="item in currentConfiguration.services" :key="item.id" type="button" class="chip-btn"
              @click="applyServicePreset(item)">
              {{ item.name }} · ¥{{ displayCents(item.priceCents) }}
            </button>
          </div>
        </div>

        <div v-for="(line, index) in form.lines" :key="index" class="book-fields" style="background: #f8fafc; padding: 0.625rem; border-radius: 0.75rem; border: 1px solid #e2e8f0;">
          <label>项目
            <select v-model="line.id" @change="onLineServiceChange(line)">
              <option value="">自定义项目</option>
              <option v-for="item in currentConfiguration.services" :key="item.id" :value="item.id">{{ item.name }} · ¥{{ displayCents(item.priceCents) }}</option>
            </select>
          </label>
          <label v-if="!line.id">项目名称<input v-model.trim="line.name" maxlength="128" placeholder="项目名称" required></label>
          <label v-if="!line.id">单价（元）<input v-model.trim="line.price" inputmode="decimal" placeholder="0.00" required></label>
          <label>数量<input v-model.number="line.quantity" type="number" min="1" max="9999" required></label>
          <button type="button" class="book-btn" :disabled="form.lines.length === 1" @click="form.lines.splice(index, 1)">移除</button>
        </div>
        <button type="button" class="book-btn" :disabled="form.lines.length === 100" @click="addLine">＋ 添加服务项目</button>
      </template>

      <!-- 冲正视图 -->
      <div v-else-if="type === 'reverse'" style="padding: 0.75rem; background: #faf5ff; border: 1px solid #f3e8ff; border-radius: 0.75rem;">
        <p style="margin: 0; font-weight: 600; color: #6b21a8;">原单 {{ entry.id }}，变动 ¥{{ displayCents(entry.deltaCents) }}。冲正只调整账务，实际退款需另行处理。</p>
        <p v-if="currentMember.archivedAt" style="margin: 0.25rem 0 0; font-size: 0.8125rem; color: #7e22ce;">这位会员已归档。冲正成功后会恢复原档案。如果手机号已由其他在用会员使用，须先核对并更正号码。</p>
      </div>

      <label>{{ type === 'reverse' ? '冲正原因' : '备注' }}
        <input v-model.trim="form.note" maxlength="1000" placeholder="选填，补充说明">
      </label>

      <!-- 欠款允许复选框 -->
      <label v-if="type !== 'recharge'" class="book-inline" style="background: #fffafa; border: 1px solid #fed7aa; padding: 0.5rem 0.75rem; border-radius: 0.625rem; color: #9a3412;">
        <input v-model="form.allowDebt" type="checkbox">
        <span style="font-weight: 600; font-size: 0.875rem;">确认允许本次交易产生欠款</span>
      </label>

      <p v-if="error" class="book-panel book-alert" role="alert">{{ error }}</p>

      <!-- 试算核对预览区域 -->
      <div v-if="preview" class="book-alert" role="status" style="background: #f0fdf4; border-color: #bbf7d0; color: #166534;">
        <p style="font-size: 1rem; font-weight: 750;">
          本次变动 ¥{{ displayCents(preview.financial.deltaCents) }}；确认后余额 <strong>¥{{ displayCents(preview.financial.balanceAfterCents) }}</strong>。
        </p>
        <p v-if="debtIncrease" style="color: #b91c1c; font-weight: 700;">
          本次新增欠款 ¥{{ displayCents(debtIncrease) }}；总欠款 ¥{{ displayCents((-BigInt(preview.financial.balanceAfterCents)).toString()) }}。
        </p>
        <p v-if="type === 'recharge'">实收 ¥{{ displayCents(preview.draft.actualPayCents) }}，赠送 ¥{{ displayCents(preview.draft.giftCents) }}。</p>
      </div>

      <!-- 操作按钮栏 -->
      <div class="book-actions" style="margin-top: 0.5rem; gap: 0.5rem;">
        <button v-if="!preview" class="book-primary" type="submit" :disabled="busy || blocked" aria-label="核对金额" style="flex: 1; min-height: 2.875rem; font-size: 1rem;">
          核对金额
        </button>
        <button v-else class="book-primary" type="button" :disabled="busy || blocked"
          :aria-label="type === 'consume' ? '确认扣款' : type === 'recharge' ? '确认充值' : '确认冲正'"
          @click="commit" style="flex: 1; min-height: 2.875rem; font-size: 1rem;">
          确认{{ type === 'consume' ? '扣款' : type === 'recharge' ? '充值' : '冲正' }}
        </button>
        <button type="button" class="book-btn" :disabled="busy" aria-label="关闭" @click="$emit('close')" style="min-height: 2.875rem;">关闭</button>
      </div>
    </form>
  </div>
</template>

<script setup>
import { reactive, ref, shallowRef, watch, computed, onScopeDispose } from 'vue';
import { displayCents, suggestedGift, yuanCents } from '../relational-presentation.js';
import { createRecharge, createConsumption, createReversal, applyFinancialCommand, centsString } from '../ledger-domain.js';
import { prepareSale } from '../relational-sales.js';

const props = defineProps({ workspace: Object, scope: Object, type: String, member: Object, configuration: Object, entry: Object });
const emit = defineEmits(['close', 'done']);

const line = () => ({ id: '', name: '', price: '', quantity: 1 });
const form = reactive({ planId: '', pay: '', gift: '', note: '', allowDebt: false, payment: '微信', payments: [{ method: '微信', amount: '' }], lines: [line()] });
const preview = ref(null), busy = ref(false), error = ref('');
const currentMember = shallowRef(props.member), currentConfiguration = shallowRef(props.configuration);
let alive = true;
onScopeDispose(() => { alive = false; });

const blocked = computed(() => Boolean(!props.workspace.state.book || props.workspace.state.pending || props.workspace.state.pendingError));
const debtIncrease = computed(() => {
  if (!preview.value || props.type === 'recharge') return null;
  const before = BigInt(currentMember.value.balanceCents), after = BigInt(preview.value.financial.balanceAfterCents);
  return after < (before < 0n ? before : 0n) ? ((before < 0n ? before : 0n) - after).toString() : null;
});

watch(form, () => { preview.value = null; error.value = ''; }, { deep: true, flush: 'sync' });

function goBack() {
  if (busy.value) return;
  if (preview.value) { preview.value = null; form.allowDebt = false; }
  else emit('close');
}
defineExpose({ goBack });

function addLine() { form.lines.push(line()); }

function selectPlan() {
  const plan = currentConfiguration.value.rechargePlans.find(row => row.id === form.planId);
  form.pay = plan ? displayCents(plan.payCents) : '';
  form.gift = plan ? displayCents(plan.giftCents) : '';
}

function applyServicePreset(item) {
  if (form.lines.length === 1 && !form.lines[0].id && !form.lines[0].name) {
    form.lines[0].id = item.id;
    form.lines[0].name = item.name;
    form.lines[0].price = displayCents(item.priceCents);
    form.lines[0].quantity = 1;
  } else {
    form.lines.push({ id: item.id, name: item.name, price: displayCents(item.priceCents), quantity: 1 });
  }
}

function onLineServiceChange(row) {
  const service = currentConfiguration.value.services.find(item => item.id === row.id);
  if (service) {
    row.name = service.name;
    row.price = displayCents(service.priceCents);
  }
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
      const items = form.lines.map(row => {
        const service = configuration.services.find(item => item.id === row.id);
        if (!Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 9999) throw new Error('项目数量须为 1–9999');
        return {
          ...(service ? { serviceId: service.id } : {}),
          name: service?.name ?? row.name,
          unitPriceCents: service?.priceCents ?? yuanCents(row.price),
          quantity: row.quantity
        };
      });
      draft = {
        ...base, amountCents: centsString(items.reduce((sum, item) => sum + BigInt(item.unitPriceCents) * BigInt(item.quantity), 0n)),
        items, itemsSummary: Array.from(items.map(item => item.name).join('、')).slice(0, 128).join(''),
        configurationVersion: configuration.version, remark: form.note, allowDebt: form.allowDebt
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
        if (alive) { currentMember.value = member; error.value = '会员资料或余额已变化，请核对最新资料并重新确认。'; }
      } else if (cause.code === 'CONFIGURATION_VERSION_CHANGED') {
        const configuration = await props.workspace.read('getConfiguration');
        if (alive) {
          currentConfiguration.value = configuration;
          if (form.planId) { form.planId = ''; form.pay = ''; }
          form.gift = '';
          for (const row of form.lines) if (row.id && !configuration.services.some(item => item.id === row.id)) row.id = '';
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
