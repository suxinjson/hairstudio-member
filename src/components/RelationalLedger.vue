<template>
  <section class="book-stack space-y-3" aria-label="财务流水">
    <!-- 聚合筛选与多条件面板 -->
    <div class="bg-white border border-slate-200/90 rounded-2xl p-3.5 shadow-xs space-y-2.5">
      <!-- 会员指定筛选横幅 -->
      <div v-if="memberId" class="flex items-center justify-between p-2 bg-emerald-50/80 rounded-xl border border-emerald-200/60 text-xs">
        <span class="text-emerald-900 font-bold flex items-center gap-1.5">
          <span>👤</span>
          <span>当前筛选会员：<strong>{{ memberName || memberId }}</strong></span>
        </span>
        <button
          type="button"
          class="px-2.5 py-1 bg-white border border-emerald-300 text-emerald-800 rounded-lg font-bold text-xs hover:bg-emerald-50 btn-press"
          @click="$emit('all-members')"
        >
          查看全部
        </button>
      </div>

      <!-- 流水类型快捷切换 -->
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-bold text-slate-500 shrink-0">类型：</span>
        <div class="ledger-type-options flex-1" role="tablist" aria-label="流水类型筛选">
          <button
            v-for="t in typeOptions"
            :key="t.value"
            type="button"
            role="tab"
            :aria-selected="kind === t.value"
            class="px-2.5 py-1 rounded-xl text-xs font-bold transition-all shrink-0"
            :class="kind === t.value ? 'bg-slate-900 text-white shadow-xs' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'"
            @click="selectKind(t.value)"
          >
            {{ t.label }}
          </button>
        </div>
      </div>

      <!-- 时间周期快捷切换 -->
      <div class="flex items-center justify-between gap-2 pt-1 border-t border-slate-100">
        <span class="text-xs font-bold text-slate-500 shrink-0">时间：</span>
        <div class="ledger-period-options flex-1" role="tablist" aria-label="时间周期筛选">
          <button
            v-for="p in periodOptions"
            :key="p.value"
            type="button"
            role="tab"
            :aria-selected="period === p.value"
            class="px-2.5 py-1 rounded-xl text-xs font-bold transition-all shrink-0"
            :class="period === p.value ? 'bg-emerald-700 text-white shadow-xs' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'"
            @click="selectPeriod(p.value)"
          >
            {{ p.label }}
          </button>
        </div>
      </div>

      <!-- 自选起止日期面板 -->
      <form v-if="period === 'custom'" class="report-custom-range pt-2 border-t border-slate-100 gap-2" @submit.prevent="search">
        <label class="text-xs font-bold text-slate-600 flex items-center gap-1">
          起<input v-model="from" type="date" class="text-xs p-1.5 border border-slate-200 rounded-lg bg-slate-50 font-medium" />
        </label>
        <label class="text-xs font-bold text-slate-600 flex items-center gap-1">
          止<input v-model="to" type="date" class="text-xs p-1.5 border border-slate-200 rounded-lg bg-slate-50 font-medium" />
        </label>
        <button type="submit" class="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg text-xs font-bold btn-press">
          查询
        </button>
      </form>
    </div>

    <p v-if="error" class="book-panel book-alert" role="alert">{{ error }}</p>
    <p v-if="receipt" class="p-3 bg-emerald-50 border border-emerald-200 rounded-2xl text-xs font-bold text-emerald-800" role="status">{{ receipt }}</p>

    <!-- 冲正弹窗 -->
    <RelationalSale v-if="reversing" ref="saleForm" v-bind="reversing" :key="reversing.entry.id" :workspace="workspace" type="reverse" @close="reversing = null" @done="reversed" />

    <div v-if="page.error.value" class="book-panel book-alert" role="alert"><p>{{ page.error.value }}</p><button type="button" :disabled="page.busy.value" @click="search">重试查询流水</button></div>
    <div v-else-if="page.busy.value" class="bg-white border border-slate-200 rounded-2xl p-8 text-center" role="status">
      <div class="text-2xl animate-spin inline-block">⏳</div>
      <p class="text-xs text-slate-500 font-medium mt-2">正在查询流水记录…</p>
    </div>
    <div v-else class="space-y-2.5">
      <div v-if="!page.rows.value.length" class="bg-white border border-slate-200/90 rounded-2xl p-8 text-center">
        <p class="text-xs text-slate-400 font-medium m-0">没有符合条件的交易流水记录</p>
      </div>

      <!-- 现代化流水卡片列表 -->
      <ul v-else class="space-y-2 p-0 m-0 list-none">
        <li
          v-for="entry in page.rows.value"
          :key="entry.id"
          class="ledger-entry bg-white border border-slate-200/90 rounded-2xl p-3.5 shadow-xs transition-shadow hover:shadow-sm"
          :class="{ 'ledger-entry-wide': displayAbsoluteCents(entry.deltaCents).length > 12 }"
        >
          <!-- 首行：徽章、会员姓名与变动金额 -->
          <div class="ledger-entry-heading flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <span
                class="w-7 h-7 rounded-lg text-xs font-black flex items-center justify-center shrink-0"
                :class="entry.type === 'recharge' ? 'bg-emerald-100 text-emerald-800' : entry.type === 'consume' ? 'bg-amber-100 text-amber-800' : 'bg-purple-100 text-purple-800'"
              >
                {{ labels[entry.type] || '记录' }}
              </span>
              <strong class="ledger-entry-name text-sm font-bold text-slate-900">
                {{ entry.memberName || memberName || entry.memberId }}
              </strong>
            </div>

            <!-- 金额变化 -->
            <strong
              class="ledger-movement text-base font-black shrink-0"
              :class="entry.type === 'recharge' ? 'text-emerald-700' : entry.type === 'consume' ? 'text-rose-600' : 'text-purple-700'"
            >
              {{ BigInt(entry.deltaCents || 0) > 0n ? '+' : BigInt(entry.deltaCents || 0) < 0n ? '−' : '' }}¥{{ displayAbsoluteCents(entry.deltaCents) }}
            </strong>
          </div>

          <!-- 次行：时间、变动后余额与状态 -->
          <div class="ledger-entry-meta flex items-center justify-between text-xs text-slate-400 font-medium mt-1.5">
            <time :datetime="entry.occurredAt">{{ timestamp(entry.confirmedAt || entry.occurredAt) }}</time>
            <div class="flex items-center gap-2">
              <span class="text-slate-500 font-semibold">变动后{{ BigInt(entry.balanceAfterCents || 0) < 0n ? '欠款' : '余额' }} ¥{{ displayAbsoluteCents(entry.balanceAfterCents) }}</span>
              <span v-if="entry.reversed" class="text-rose-600 font-black">已冲正</span>
              <span v-else-if="workspace.mode === 'cloud' && !entry.confirmedAt" class="text-amber-600 font-black">待确认</span>
            </div>
          </div>

          <!-- 展开详细信息折叠框 -->
          <details class="mt-2 pt-2 border-t border-slate-100 text-xs text-slate-600">
            <summary class="cursor-pointer font-bold text-emerald-800 hover:text-emerald-900 select-none py-0.5">
              查看单号与明细 ›
            </summary>
            <div class="mt-2 space-y-1 bg-slate-50 p-2.5 rounded-xl border border-slate-100 text-[11px] font-medium text-slate-600">
              <p class="m-0 break-all">流水单号：{{ entry.id }}</p>
              <p v-if="entry.originalEntryId" class="m-0 break-all text-slate-500">原单号：{{ entry.originalEntryId }}</p>
              <p v-if="entry.reversalEntryId" class="m-0 break-all text-rose-600">冲正单号：{{ entry.reversalEntryId }}</p>
              <p v-if="entry.remark" class="m-0 font-bold text-slate-800">服务备注：{{ entry.remark }}</p>
              <p v-for="(item, idx) in entry.items" :key="'it' + idx" class="m-0">
                • {{ item.name }} × {{ item.quantity }} = ¥{{ displayCents(item.lineTotalCents) }}
              </p>
              <p v-for="(pay, idx) in entry.payments" :key="'pa' + idx" class="m-0">
                • 支付方式：{{ pay.method }} ¥{{ displayCents(pay.amountCents) }}
              </p>
              <p v-if="entry.recharge" class="m-0 text-emerald-700 font-bold">
                • 实收 ¥{{ displayCents(entry.recharge.actualPayCents) }}，赠送 ¥{{ displayCents(entry.recharge.giftCents) }}
              </p>
            </div>
          </details>

          <!-- 冲正撤销按钮 (仅店主且未冲正单) -->
          <div v-if="owner && entry.type !== 'reversal' && !entry.reversed" class="flex justify-end mt-2">
            <button
              type="button"
              class="px-2.5 py-1 text-xs font-bold text-rose-600 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg btn-press transition-colors"
              :disabled="blocked"
              aria-label="账务冲正"
              @click="reverse(entry)"
            >
              账务冲正
            </button>
          </div>
        </li>
      </ul>

      <!-- 分页控制 -->
      <div class="flex items-center justify-between p-3 bg-white border border-slate-200/90 rounded-2xl text-xs font-bold text-slate-600 shadow-xs">
        <div class="flex items-center gap-2">
          <button v-if="page.cursor.value" type="button" class="text-emerald-800 hover:text-emerald-900" aria-label="回到第一页" @click="page.load()">
            首页
          </button>
          <button v-if="page.next.value" type="button" class="text-emerald-800 hover:text-emerald-900" aria-label="下一页" @click="page.load(page.next.value)">
            下一页 ›
          </button>
        </div>
        <span class="text-[11px] text-slate-400">本页 {{ page.rows.value.length }} 条 · 营业日 UTC+8</span>
      </div>
    </div>
  </section>
</template>

<script setup>
import { ref, shallowRef, computed, watch, onScopeDispose } from 'vue';
import { useRelationalPage } from '../composables/useRelationalPage.js';
import { useBusinessDay } from '../composables/useBusinessDay.js';
import { displayAbsoluteCents, displayCents, businessDays, todayBusiness } from '../relational-presentation.js';
import RelationalSale from './RelationalSale.vue';

const props = defineProps({
  workspace: Object,
  owner: Boolean,
  memberId: String,
  memberName: String,
  searchQuery: { type: String, default: '' }
});
defineEmits(['all-members']);

const typeOptions = [
  { value: '', label: '全部' },
  { value: 'consume', label: '消费扣款' },
  { value: 'recharge', label: '充值入账' },
  { value: 'reversal', label: '撤销冲正' }
];

const periodOptions = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: 'week', label: '近7天' },
  { value: 'month', label: '本月' },
  { value: 'custom', label: '自选' }
];

const query = ref(props.searchQuery || '');
const kind = ref('');
const period = ref('all');
const businessDay = useBusinessDay();
const from = ref('');
const to = ref('');
const error = ref('');
const receipt = ref('');
const reversing = shallowRef(null);
const loading = ref(false);
const saleForm = ref(null);

const hasOpenAction = computed(() => Boolean(reversing.value || loading.value));
const blocked = computed(() => loading.value || !props.workspace.state.book || props.workspace.state.pending || props.workspace.state.pendingError || props.workspace.state.busy);
const labels = { consume: '消费', recharge: '充值', reversal: '冲正' };
const timestamp = value => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(value));

let criteria = { search: query.value }, alive = true, searchTimer, selection = 0, criteriaError = null;
onScopeDispose(() => { alive = false; selection++; clearTimeout(searchTimer); });

const page = useRelationalPage(cursor => {
  if (criteriaError) return Promise.reject(criteriaError);
  return props.workspace.read('listLedger', { ...criteria, memberId: props.memberId || '', cursor, limit: 25 });
});
defineExpose({
  hasOpenAction,
  search,
  goBack: () => {
    if (reversing.value) { saleForm.value?.goBack(); return true; }
    if (loading.value) { selection++; loading.value = false; return true; }
    return false;
  }
});

function selectKind(val) {
  kind.value = val;
  search();
}

function selectPeriod(val) {
  period.value = val;
  if (val !== 'custom') search();
}

function applyPreset() {
  const today = todayBusiness();
  if (period.value === 'all') {
    from.value = '';
    to.value = '';
  } else if (period.value === 'today') {
    from.value = today;
    to.value = today;
  } else if (period.value === 'week') {
    from.value = new Date(Date.parse(today + 'T00:00:00.000Z') - 6 * 86400000).toISOString().slice(0, 10);
    to.value = today;
  } else if (period.value === 'month') {
    from.value = today.slice(0, 7) + '-01';
    to.value = today;
  }
}

function search() {
  clearTimeout(searchTimer);
  if (period.value !== 'custom') applyPreset();
  error.value = '';
  criteriaError = null;
  try {
    if (period.value === 'custom' && (!from.value || !to.value)) throw new Error('请选择完整的起止日期。');
    criteria = { search: query.value, kind: kind.value, ...(from.value && to.value ? businessDays(from.value, to.value) : {}) };
  } catch (cause) { criteriaError = cause; }
  void page.load();
}

watch(businessDay, () => {
  if (['today', 'week', 'month'].includes(period.value)) search();
});

watch(() => props.searchQuery, val => {
  if (val !== undefined && val !== query.value) {
    query.value = val;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { if (alive) search(); }, 150);
  }
});

watch(() => [props.workspace.state.revision, props.memberId], () => {
  if (props.workspace.state.book) void page.load();
}, { immediate: true });

async function reverse(entry) {
  if (blocked.value) return;
  error.value = '';
  receipt.value = '';
  loading.value = true;
  const request = ++selection;
  try {
    const member = await props.workspace.read('getMember', entry.memberId);
    if (!alive || request !== selection) return;
    reversing.value = { entry, member, scope: props.workspace.getScope() };
  } catch (cause) {
    if (alive && request === selection) error.value = cause.message;
  } finally {
    if (alive && request === selection) loading.value = false;
  }
}

function reversed(result) {
  reversing.value = null;
  receipt.value = '冲正成功，单号 ' + result.entryId + ' · 恢复后余额 ¥' + displayCents(result.balanceAfterCents);
}
</script>
