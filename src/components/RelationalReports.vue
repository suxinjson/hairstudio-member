<template>
  <section class="book-stack" aria-label="经营报表">
    <!-- 日期筛选面板 -->
    <form class="book-panel book-stack" @submit.prevent="refresh" style="padding: 0.875rem 1rem;">
      <div class="book-fields">
        <label>起始日<input v-model="first" type="date" required></label>
        <label>结束日<input v-model="last" type="date" required></label>
        <button type="submit" class="book-primary" style="min-height: 2.75rem;">查询报表</button>
      </div>
      <span class="book-muted" style="margin-top: 0.25rem;">营业日 UTC+8，按交易及冲正发生日期统计。</span>
    </form>

    <p v-if="error" class="book-panel book-alert" role="alert">{{ error }}</p>
    <div v-if="loading" class="book-panel book-stack" style="text-align: center; padding: 2rem 1rem;" role="status">
      <div style="font-size: 1.5rem; animation: spin 1s linear infinite; display: inline-block;">⏳</div>
      <p style="margin: 0.5rem 0 0; color: #64748b;">正在计算经营报表…</p>
    </div>

    <template v-if="result">
      <p v-if="result.localState?.mode === 'cloud'" class="book-panel" style="background: #f0fdf4; border-color: #bbf7d0; color: #166534;" role="status">
        本机副本报表 · 水位 {{ result.localState.cursor }} · 待提交 {{ result.localState.pendingCount }} 笔 · 冲突 {{ result.localState.conflictCount }} 笔
      </p>

      <!-- 核心经营简报 KPI 卡片 -->
      <div class="book-panel book-stack">
        <h3 style="font-size: 1.05rem; font-weight: 800; color: #123c32; margin: 0 0 0.5rem;">经营简报</h3>
        <dl class="book-metrics">
          <div v-for="[label, amount] in metrics" :key="label">
            <dt>{{ label }}</dt>
            <dd>¥{{ displayCents(amount) }}</dd>
          </div>
          <div>
            <dt>新登记会员（不含期初）</dt>
            <dd style="font-size: 1.25rem;">{{ result.summary.newActiveMemberCount }} 人</dd>
          </div>
          <div>
            <dt>消费笔数 / 人数</dt>
            <dd style="font-size: 1.25rem;">{{ result.summary.consumeCount }} / {{ result.summary.consumeMemberCount }}</dd>
          </div>
        </dl>
      </div>

      <!-- 当前在用余额概览 -->
      <div class="book-panel book-stack">
        <h3 style="font-size: 1.05rem; font-weight: 800; color: #123c32; margin: 0 0 0.5rem;">当前在用余额</h3>
        <p style="margin: 0; font-size: 0.875rem; color: #475569;">
          共 {{ result.balances.memberCount }} 人：欠款 {{ result.balances.debtCount }}，余额为零 {{ result.balances.zeroCount }}，0–50 元 {{ result.balances.lowCount }}，高于 50 元 {{ result.balances.fundedCount }}。
        </p>
        <div style="display: flex; gap: 1rem; margin-top: 0.35rem; flex-wrap: wrap;">
          <div style="padding: 0.5rem 0.875rem; background: #f0fdf4; border-radius: 0.625rem; border: 1px solid #bbf7d0;">
            <span style="font-size: 0.75rem; color: #166534; display: block;">在用储值总额</span>
            <strong style="font-size: 1.15rem; color: #15803d;">¥{{ displayCents(result.balances.storedCents) }}</strong>
          </div>
          <div style="padding: 0.5rem 0.875rem; background: #fff5f5; border-radius: 0.625rem; border: 1px solid #fecdd3;">
            <span style="font-size: 0.75rem; color: #991b1b; display: block;">当前欠款余额</span>
            <strong style="font-size: 1.15rem; color: #dc2626;">¥{{ displayCents(result.balances.debtCents) }}</strong>
          </div>
        </div>
      </div>

      <!-- 趋势表格 -->
      <div class="book-panel book-stack">
        <h3 style="font-size: 1.05rem; font-weight: 800; color: #123c32; margin: 0 0 0.5rem;">{{ result.trendUnit === 'month' ? '月' : '日' }}趋势</h3>
        <div class="book-scroll">
          <table>
            <thead>
              <tr><th>期间</th><th>净充值到账</th><th>净消费</th><th>余额变化</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in result.trend" :key="row.date">
                <td style="font-weight: 600;">{{ row.date }}</td>
                <td style="color: #15803d;">¥{{ displayCents(row.netRechargeCreditCents) }}</td>
                <td style="color: #e11d48;">¥{{ displayCents(row.netConsumptionCents) }}</td>
                <td style="font-weight: 700;">¥{{ displayCents(row.netChangeCents) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 净消费排行 -->
      <div class="book-panel book-stack">
        <h3 style="font-size: 1.05rem; font-weight: 800; color: #123c32; margin: 0 0 0.5rem;">净消费前十</h3>
        <p v-if="!result.ranking.length" style="color: #64748b; margin: 0;">期间没有可列入排行的净消费。</p>
        <ol v-else class="book-list" style="padding-left: 0; counter-reset: rank;">
          <li v-for="(row, idx) in result.ranking" :key="row.memberId" style="padding: 0.5rem 0.25rem;">
            <div style="display: flex; align-items: center; gap: 0.625rem;">
              <span :style="{
                width: '22px', height: '22px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.75rem', fontWeight: '800',
                background: idx === 0 ? '#fef08a' : idx === 1 ? '#e2e8f0' : idx === 2 ? '#ffedd5' : '#f1f5f9',
                color: idx < 3 ? '#1e293b' : '#64748b'
              }">{{ idx + 1 }}</span>
              <strong style="color: #1e293b;">{{ row.name }}</strong>
            </div>
            <strong style="color: #167c68; font-size: 1.05rem;">¥{{ displayCents(row.netConsumptionCents) }}</strong>
          </li>
        </ol>
      </div>

      <!-- 成交明细汇总 -->
      <div class="book-panel book-stack">
        <div class="book-inline book-between" style="margin-bottom: 0.25rem;">
          <h3 style="margin: 0; font-size: 1.05rem; font-weight: 800; color: #123c32;">成交明细汇总</h3>
          <label class="book-inline" style="font-size: 0.8125rem;">
            分组：
            <select v-model="kind" @change="breakdown.load()" style="min-height: 2.25rem; padding: 0.25rem 0.5rem; font-size: 0.8125rem;">
              <option value="payment">付款方式</option>
              <option value="service">服务项目</option>
            </select>
          </label>
        </div>
        <p v-if="breakdown.error.value" class="book-alert" role="alert">{{ breakdown.error.value }}</p>
        <p v-else-if="breakdown.busy.value" role="status" style="color: #64748b;">正在查询明细…</p>
        <p v-else-if="!breakdown.rows.value.length" style="color: #64748b; margin: 0;">没有符合期间的成交明细。</p>
        <div v-else class="book-scroll">
          <table>
            <thead>
              <tr><th>名称</th><th v-if="kind === 'service'">净数量</th><th>净额（元）</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in breakdown.rows.value" :key="row.name + ':' + (row.serviceId || '')">
                <td style="font-weight: 600;">{{ row.name }}</td>
                <td v-if="kind === 'service'">{{ row.quantity }}</td>
                <td style="font-weight: 700;">¥{{ displayCents(row.amountCents) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="book-actions" style="margin-top: 0.35rem; gap: 0.5rem;">
          <button v-if="breakdown.cursor.value" type="button" class="book-btn" @click="breakdown.load()">回到第一页</button>
          <button v-if="breakdown.next.value" type="button" class="book-btn" @click="breakdown.load(breakdown.next.value)">下一页明细</button>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup>
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { displayCents, businessDays, todayBusiness, BUSINESS_OFFSET } from '../relational-presentation.js';
import { useRelationalPage } from '../composables/useRelationalPage.js';

const props = defineProps({ workspace: Object });
const last = ref(todayBusiness()), first = ref(last.value.slice(0, 7) + '-01'), kind = ref('payment');
const result = shallowRef(null), loading = ref(false), error = ref('');

let scope = businessDays(first.value, last.value), sequence = 0;
onScopeDispose(() => { sequence++; });

const breakdown = useRelationalPage(cursor => props.workspace.read('reportBreakdown', { ...scope, kind: kind.value, cursor, limit: 25 }));
const metrics = computed(() => {
  const row = result.value?.summary;
  return row ? [
    ['充值实收', row.actualPayCents], ['赠送', row.giftCents], ['充值到账毛额', row.rechargeCreditCents],
    ['冲正实收', row.reversedActualPayCents], ['冲正赠送', row.reversedGiftCents], ['净充值到账', row.netRechargeCreditCents],
    ['消费毛额', row.consumptionCents], ['冲正消费', row.reversedConsumptionCents], ['净消费', row.netConsumptionCents],
    ['消费均额（毛额）', row.averageConsumeCents], ['余额净变化', row.netChangeCents]
  ] : [];
});

async function load() {
  const request = ++sequence; loading.value = true; result.value = null; error.value = '';
  try {
    const value = await props.workspace.read('reportBusiness', { ...scope, offsetMinutes: BUSINESS_OFFSET });
    if (request === sequence) { result.value = value; void breakdown.load(); }
  } catch (cause) { if (request === sequence) error.value = cause.message; }
  finally { if (request === sequence) loading.value = false; }
}

function refresh() {
  try { scope = businessDays(first.value, last.value); void load(); }
  catch (cause) { error.value = cause.message; }
}

watch(() => props.workspace.state.revision, () => { if (props.workspace.state.book) void load(); }, { immediate: true });
</script>
