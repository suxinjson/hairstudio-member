<template>
  <section class="book-stack space-y-3.5" aria-label="经营报表">
    <!-- 统计周期快速切换与日期筛选 -->
    <div class="bg-white border border-slate-200/90 rounded-2xl p-3.5 shadow-xs">
      <div class="flex items-center justify-between gap-2 mb-2.5">
        <h3 class="text-xs font-black text-slate-700 m-0 flex items-center gap-1.5">
          <span>📅</span>
          <span>统计周期</span>
        </h3>
        <span class="text-[11px] text-slate-400 font-medium">营业日 UTC+8</span>
      </div>

      <!-- 快速周期胶囊切换 -->
      <div class="flex gap-1 overflow-x-auto pb-1 no-scrollbar" role="tablist" aria-label="统计周期快捷切换">
        <button
          v-for="p in periodOptions"
          :key="p.value"
          type="button"
          class="px-2.5 py-1.5 rounded-xl text-xs font-bold transition-all shrink-0"
          :class="period === p.value ? 'bg-emerald-700 text-white shadow-xs' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'"
          @click="selectPeriod(p.value)"
        >
          {{ p.label }}
        </button>
      </div>

      <!-- 自选日期区间 -->
      <form v-if="period === 'custom'" class="mt-2.5 pt-2.5 border-t border-slate-100 flex flex-wrap items-center gap-2" @submit.prevent="refresh">
        <label class="text-xs font-bold text-slate-600 flex items-center gap-1">
          起<input v-model="first" type="date" required class="text-xs p-1.5 border border-slate-200 rounded-lg bg-slate-50 font-medium" />
        </label>
        <label class="text-xs font-bold text-slate-600 flex items-center gap-1">
          止<input v-model="last" type="date" required class="text-xs p-1.5 border border-slate-200 rounded-lg bg-slate-50 font-medium" />
        </label>
        <button type="submit" class="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg text-xs font-bold btn-press">
          查询
        </button>
      </form>
    </div>

    <p v-if="error" class="book-panel book-alert" role="alert">{{ error }}</p>
    <div v-if="loading" class="bg-white border border-slate-200 rounded-2xl p-8 text-center" role="status">
      <div class="text-2xl animate-spin inline-block">⏳</div>
      <p class="text-xs text-slate-500 font-medium mt-2">正在计算经营报表…</p>
    </div>

    <template v-if="result">
      <!-- 1. 核心经营业绩 KPI 四宫格 -->
      <div class="grid grid-cols-2 gap-2.5">
        <!-- 充值到账 -->
        <div class="bg-white border border-slate-200/90 rounded-2xl p-3.5 shadow-xs">
          <span class="text-[11px] font-bold text-slate-500 flex items-center gap-1">
            <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
            <span>充值到账额度</span>
          </span>
          <strong class="block text-lg font-black text-emerald-800 mt-1 leading-tight">
            ¥{{ displayCents(result.summary.netRechargeCreditCents) }}
          </strong>
          <small class="block text-[11px] text-slate-400 mt-1 truncate">
            实收 ¥{{ displayCents(result.summary.actualPayCents) }} · 赠 ¥{{ displayCents(result.summary.giftCents) }}
          </small>
        </div>

        <!-- 消费扣款 -->
        <div class="bg-white border border-slate-200/90 rounded-2xl p-3.5 shadow-xs">
          <span class="text-[11px] font-bold text-slate-500 flex items-center gap-1">
            <span class="w-2 h-2 rounded-full bg-rose-500"></span>
            <span>消费扣款金额</span>
          </span>
          <strong class="block text-lg font-black text-rose-700 mt-1 leading-tight">
            ¥{{ displayCents(result.summary.netConsumptionCents) }}
          </strong>
          <small class="block text-[11px] text-slate-400 mt-1 truncate">
            {{ result.summary.consumeCount }} 笔 · {{ result.summary.consumeMemberCount }} 人消费
          </small>
        </div>

        <!-- 笔均消费 -->
        <div class="bg-white border border-slate-200/90 rounded-2xl p-3.5 shadow-xs">
          <span class="text-[11px] font-bold text-slate-500 flex items-center gap-1">
            <span class="w-2 h-2 rounded-full bg-blue-500"></span>
            <span>笔均消费（客单价）</span>
          </span>
          <strong class="block text-lg font-black text-slate-800 mt-1 leading-tight">
            ¥{{ displayCents(result.summary.averageConsumeCents) }}
          </strong>
          <small class="block text-[11px] text-slate-400 mt-1 truncate">
            消费毛额 ÷ 笔数
          </small>
        </div>

        <!-- 新增在用会员 -->
        <div class="bg-white border border-slate-200/90 rounded-2xl p-3.5 shadow-xs">
          <span class="text-[11px] font-bold text-slate-500 flex items-center gap-1">
            <span class="w-2 h-2 rounded-full bg-purple-500"></span>
            <span>新增在用会员</span>
          </span>
          <strong class="block text-lg font-black text-purple-700 mt-1 leading-tight">
            {{ result.summary.newActiveMemberCount }} <span class="text-xs font-normal text-slate-500">人</span>
          </strong>
          <small class="block text-[11px] text-slate-400 mt-1 truncate">
            期间登记且在用
          </small>
        </div>
      </div>

      <!-- 2. 充值与消费趋势图表 (SVG 走势图) -->
      <section class="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
        <div class="flex items-center justify-between gap-2 mb-3">
          <h3 class="text-sm font-black text-slate-800 m-0">充值与消费趋势</h3>
          <div class="flex items-center gap-3 text-[11px] font-bold">
            <span class="flex items-center gap-1 text-emerald-700">
              <span class="w-2.5 h-1 bg-emerald-600 rounded-full"></span>
              充值到账
            </span>
            <span class="flex items-center gap-1 text-rose-600">
              <span class="w-2.5 h-1 bg-rose-500 rounded-full"></span>
              消费扣款
            </span>
          </div>
        </div>

        <!-- SVG 折线图 -->
        <div v-if="result.trend && result.trend.length" class="overflow-x-auto no-scrollbar">
          <svg class="w-full h-36 min-w-[280px]" viewBox="0 0 360 140" role="img" aria-label="充值与消费趋势图">
            <!-- 网格参考线 -->
            <line x1="10" x2="350" y1="20" y2="20" stroke="#f1f5f9" stroke-width="1" />
            <line x1="10" x2="350" y1="70" y2="70" stroke="#f1f5f9" stroke-width="1" />
            <line x1="10" x2="350" y1="120" y2="120" stroke="#f1f5f9" stroke-width="1" />

            <!-- 充值折线 (绿色) -->
            <polyline
              :points="chartPoints('netRechargeCreditCents')"
              fill="none"
              stroke="#15803d"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <!-- 消费折线 (红色) -->
            <polyline
              :points="chartPoints('netConsumptionCents')"
              fill="none"
              stroke="#e11d48"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />

            <!-- 数据圆点与提示 -->
            <g v-for="(day, idx) in result.trend" :key="day.date">
              <circle :cx="chartX(idx)" :cy="chartY(day.netRechargeCreditCents)" r="3" fill="#15803d">
                <title>{{ day.date }} 充值 ¥{{ displayCents(day.netRechargeCreditCents) }}</title>
              </circle>
              <circle :cx="chartX(idx)" :cy="chartY(day.netConsumptionCents)" r="3" fill="#e11d48">
                <title>{{ day.date }} 消费 ¥{{ displayCents(day.netConsumptionCents) }}</title>
              </circle>
              <!-- 日期标签 -->
              <text
                v-if="showDateTick(idx)"
                :x="chartX(idx)"
                y="136"
                text-anchor="middle"
                font-size="9"
                fill="#94a3b8"
                font-weight="600"
              >
                {{ day.date.slice(5) }}
              </text>
            </g>
          </svg>
        </div>
        <p v-else class="text-xs text-slate-400 text-center py-6 m-0">所选周期内暂无变动数据</p>

        <!-- 展开每日明细表格 -->
        <details class="mt-3 pt-2.5 border-t border-slate-100 text-xs text-slate-600">
          <summary class="cursor-pointer font-bold text-emerald-800 hover:text-emerald-900 select-none py-1">
            查看每日汇总明细表 ›
          </summary>
          <div class="overflow-x-auto mt-2">
            <table class="w-full text-left border-collapse text-xs">
              <thead>
                <tr class="border-b border-slate-100 text-slate-400 font-bold">
                  <th class="py-1.5 px-2">日期</th>
                  <th class="py-1.5 px-2">净充值</th>
                  <th class="py-1.5 px-2">净消费</th>
                  <th class="py-1.5 px-2">余额变化</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in result.trend" :key="row.date" class="border-b border-slate-50 font-medium">
                  <td class="py-1.5 px-2 text-slate-800 font-semibold">{{ row.date }}</td>
                  <td class="py-1.5 px-2 text-emerald-700">¥{{ displayCents(row.netRechargeCreditCents) }}</td>
                  <td class="py-1.5 px-2 text-rose-600">¥{{ displayCents(row.netConsumptionCents) }}</td>
                  <td class="py-1.5 px-2 font-bold text-slate-700">¥{{ displayCents(row.netChangeCents) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <!-- 3. 会员账户资产概览 (余额分布) -->
      <section class="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
        <div class="flex items-center justify-between gap-2 mb-2">
          <h3 class="text-sm font-black text-slate-800 m-0">会员余额分布</h3>
          <span class="text-xs text-slate-500 font-medium">当前在用 {{ result.balances.memberCount }} 人</span>
        </div>

        <div class="grid grid-cols-2 gap-2 mt-2">
          <div class="p-3 bg-emerald-50/70 border border-emerald-200/60 rounded-xl">
            <span class="text-[11px] font-bold text-emerald-800">可用储值总额</span>
            <strong class="block text-base font-black text-emerald-700 mt-0.5">
              ¥{{ displayCents(result.balances.storedCents) }}
            </strong>
          </div>
          <div class="p-3 bg-rose-50/70 border border-rose-200/60 rounded-xl">
            <span class="text-[11px] font-bold text-rose-800">待收欠款总额</span>
            <strong class="block text-base font-black text-rose-600 mt-0.5">
              ¥{{ displayCents(result.balances.debtCents) }}
            </strong>
          </div>
        </div>

        <!-- 4 档区间统计 -->
        <div class="grid grid-cols-4 gap-1.5 mt-2.5 text-center">
          <div class="p-2 bg-slate-50 rounded-xl border border-slate-100">
            <span class="block text-[10px] text-slate-400 font-bold">50元以上</span>
            <strong class="block text-xs font-black text-slate-700 mt-0.5">{{ result.balances.fundedCount }} 人</strong>
          </div>
          <div class="p-2 bg-slate-50 rounded-xl border border-slate-100">
            <span class="block text-[10px] text-slate-400 font-bold">0–50元</span>
            <strong class="block text-xs font-black text-slate-700 mt-0.5">{{ result.balances.lowCount }} 人</strong>
          </div>
          <div class="p-2 bg-slate-50 rounded-xl border border-slate-100">
            <span class="block text-[10px] text-slate-400 font-bold">零余额</span>
            <strong class="block text-xs font-black text-slate-700 mt-0.5">{{ result.balances.zeroCount }} 人</strong>
          </div>
          <div class="p-2 bg-rose-50/60 rounded-xl border border-rose-100">
            <span class="block text-[10px] text-rose-600 font-bold">欠款会员</span>
            <strong class="block text-xs font-black text-rose-700 mt-0.5">{{ result.balances.debtCount }} 人</strong>
          </div>
        </div>
      </section>

      <!-- 4. 会员净消费排行榜 Top 10 -->
      <section class="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
        <div class="flex items-center justify-between gap-2 mb-2.5">
          <h3 class="text-sm font-black text-slate-800 m-0">会员消费排行</h3>
          <span class="text-xs text-slate-400 font-medium">前 10 名 · 按净额</span>
        </div>

        <p v-if="!result.ranking || !result.ranking.length" class="text-xs text-slate-400 text-center py-4 m-0">
          期间没有可列入排行的消费记录
        </p>
        <ol v-else class="space-y-1.5 p-0 m-0 list-none">
          <li
            v-for="(row, idx) in result.ranking"
            :key="row.memberId"
            class="flex items-center justify-between p-2 rounded-xl border border-slate-100 hover:bg-slate-50 font-medium text-xs"
          >
            <div class="flex items-center gap-2 min-w-0">
              <span
                class="w-5 h-5 rounded-md flex items-center justify-center font-black text-[11px] shrink-0"
                :class="idx === 0 ? 'bg-amber-100 text-amber-800' : idx === 1 ? 'bg-slate-200 text-slate-700' : idx === 2 ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'"
              >
                {{ idx + 1 }}
              </span>
              <strong class="text-slate-800 truncate">{{ row.name }}</strong>
            </div>
            <strong class="text-emerald-800 font-black shrink-0">¥{{ displayCents(row.netConsumptionCents) }}</strong>
          </li>
        </ol>
      </section>

      <!-- 5. 交易核对看板 -->
      <section class="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
        <h3 class="text-sm font-black text-slate-800 m-0 mb-2.5">交易核对与账户平衡</h3>
        <dl class="grid grid-cols-2 gap-2 text-xs">
          <div v-for="[label, amount] in metrics" :key="label" class="flex justify-between items-center p-2 rounded-xl bg-slate-50 border border-slate-100">
            <dt class="text-slate-500 font-medium">{{ label }}</dt>
            <dd class="text-slate-800 font-bold m-0">¥{{ displayCents(amount) }}</dd>
          </div>
        </dl>
      </section>

      <!-- 6. 成交明细结构分析 (按付款方式 / 按服务项目) -->
      <section class="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-xs">
        <div class="flex items-center justify-between gap-2 mb-3">
          <h3 class="text-sm font-black text-slate-800 m-0">成交结构汇总</h3>
          <div class="flex gap-1 bg-slate-100 p-0.5 rounded-xl text-xs font-bold">
            <button
              type="button"
              class="px-2.5 py-1 rounded-lg transition-all"
              :class="kind === 'payment' ? 'bg-white text-emerald-900 shadow-xs' : 'text-slate-500'"
              @click="kind = 'payment'; breakdown.load()"
            >
              付款方式
            </button>
            <button
              type="button"
              class="px-2.5 py-1 rounded-lg transition-all"
              :class="kind === 'service' ? 'bg-white text-emerald-900 shadow-xs' : 'text-slate-500'"
              @click="kind = 'service'; breakdown.load()"
            >
              服务项目
            </button>
          </div>
        </div>

        <p v-if="breakdown.error.value" class="book-alert text-xs" role="alert">{{ breakdown.error.value }}</p>
        <p v-else-if="breakdown.busy.value" class="text-xs text-slate-400 text-center py-4" role="status">正在查询结构明细…</p>
        <p v-else-if="!breakdown.rows.value.length" class="text-xs text-slate-400 text-center py-4 m-0">没有符合期间的结构明细</p>
        <div v-else class="overflow-x-auto">
          <table class="w-full text-left text-xs border-collapse">
            <thead>
              <tr class="border-b border-slate-100 text-slate-400 font-bold">
                <th class="py-2 px-2">名称</th>
                <th v-if="kind === 'service'" class="py-2 px-2">净数量</th>
                <th class="py-2 px-2 text-right">净额</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in breakdown.rows.value" :key="row.name + ':' + (row.serviceId || '')" class="border-b border-slate-50 font-medium">
                <td class="py-2 px-2 text-slate-800 font-semibold">{{ row.name }}</td>
                <td v-if="kind === 'service'" class="py-2 px-2 text-slate-600">{{ row.quantity }}</td>
                <td class="py-2 px-2 text-right font-black text-emerald-800">¥{{ displayCents(row.amountCents) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="breakdown.cursor.value || breakdown.next.value" class="flex justify-between items-center mt-3 pt-2 border-t border-slate-100 text-xs">
          <button v-if="breakdown.cursor.value" type="button" class="text-emerald-700 font-bold" @click="breakdown.load()">首页</button>
          <button v-if="breakdown.next.value" type="button" class="text-emerald-700 font-bold ml-auto" @click="breakdown.load(breakdown.next.value)">下一页 ›</button>
        </div>
      </section>
    </template>
  </section>
</template>

<script setup>
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { displayCents, businessDays, todayBusiness, BUSINESS_OFFSET } from '../relational-presentation.js';
import { useRelationalPage } from '../composables/useRelationalPage.js';

const props = defineProps({ workspace: Object });

const periodOptions = [
  { value: 'month', label: '本月' },
  { value: 'today', label: '今天' },
  { value: 'yesterday', label: '昨天' },
  { value: 'week', label: '近7天' },
  { value: 'last30', label: '近30天' },
  { value: 'custom', label: '自选' }
];

const period = ref('month');
const today = todayBusiness();
const last = ref(today);
const first = ref(today.slice(0, 7) + '-01');
const kind = ref('payment');
const result = shallowRef(null);
const loading = ref(false);
const error = ref('');

let scope = businessDays(first.value, last.value), sequence = 0;
onScopeDispose(() => { sequence++; });

const breakdown = useRelationalPage(cursor => props.workspace.read('reportBreakdown', { ...scope, kind: kind.value, cursor, limit: 25 }));

const metrics = computed(() => {
  const row = result.value?.summary;
  return row ? [
    ['充值实收', row.actualPayCents],
    ['充值赠送', row.giftCents],
    ['充值毛额', row.rechargeCreditCents],
    ['冲正实收', row.reversedActualPayCents],
    ['冲正赠送', row.reversedGiftCents],
    ['净充值额', row.netRechargeCreditCents],
    ['消费毛额', row.consumptionCents],
    ['冲正消费', row.reversedConsumptionCents],
    ['净消费额', row.netConsumptionCents],
    ['余额净变动', row.netChangeCents]
  ] : [];
});

function computeDates(p) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  if (p === 'today') {
    return { start: today, end: today };
  } else if (p === 'yesterday') {
    const y = new Date(now.getTime() - 86400000);
    const yStr = fmt(y);
    return { start: yStr, end: yStr };
  } else if (p === 'week') {
    const w = new Date(now.getTime() - 6 * 86400000);
    return { start: fmt(w), end: today };
  } else if (p === 'last30') {
    const m = new Date(now.getTime() - 29 * 86400000);
    return { start: fmt(m), end: today };
  } else if (p === 'month') {
    return { start: today.slice(0, 7) + '-01', end: today };
  }
  return { start: first.value, end: last.value };
}

function selectPeriod(p) {
  period.value = p;
  if (p !== 'custom') {
    const range = computeDates(p);
    first.value = range.start;
    last.value = range.end;
    refresh();
  }
}

// 图表辅助计算
const chartMax = computed(() => {
  const list = result.value?.trend || [];
  if (!list.length) return 100;
  const max = Math.max(100, ...list.flatMap(d => [Number(d.netRechargeCreditCents || 0), Number(d.netConsumptionCents || 0)]));
  return max;
});

function chartX(idx) {
  const list = result.value?.trend || [];
  if (list.length <= 1) return 180;
  return 20 + (idx / (list.length - 1)) * 320;
}

function chartY(amountCents) {
  const val = Number(amountCents || 0);
  const ratio = Math.min(1, Math.max(0, val / chartMax.value));
  return 120 - ratio * 95;
}

function chartPoints(field) {
  const list = result.value?.trend || [];
  return list.map((d, i) => `${chartX(i)},${chartY(d[field])}`).join(' ');
}

function showDateTick(idx) {
  const len = result.value?.trend?.length || 0;
  if (len <= 4) return true;
  return idx === 0 || idx === len - 1 || idx % Math.ceil(len / 4) === 0;
}

async function load() {
  const request = ++sequence;
  loading.value = true;
  result.value = null;
  error.value = '';
  try {
    const value = await props.workspace.read('reportBusiness', { ...scope, offsetMinutes: BUSINESS_OFFSET });
    if (request === sequence) {
      result.value = value;
      void breakdown.load();
    }
  } catch (cause) {
    if (request === sequence) error.value = cause.message;
  } finally {
    if (request === sequence) loading.value = false;
  }
}

function refresh() {
  try {
    scope = businessDays(first.value, last.value);
    void load();
  } catch (cause) {
    error.value = cause.message;
  }
}

watch(() => props.workspace.state.revision, () => {
  if (props.workspace.state.book) void load();
}, { immediate: true });
</script>
