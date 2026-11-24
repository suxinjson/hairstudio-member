<template>
  <section class="book-stack" aria-label="经营报表">
    <form class="book-panel book-actions" @submit.prevent="refresh">
      <label>起始日<input v-model="first" type="date" required></label>
      <label>结束日<input v-model="last" type="date" required></label>
      <button type="submit">查询报表</button>
      <span class="book-muted">营业日 UTC+8，按交易及冲正发生日期统计。</span>
    </form>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="loading" role="status">正在计算经营报表…</p>
    <template v-if="result">
      <p v-if="result.localState?.mode === 'cloud'" role="status">本机副本报表 · 水位 {{ result.localState.cursor }} · 待提交 {{ result.localState.pendingCount }} 笔 · 冲突 {{ result.localState.conflictCount }} 笔</p>
      <div class="book-panel book-stack">
        <h3>经营简报</h3>
        <dl class="book-metrics">
          <div v-for="[label, amount] in metrics" :key="label"><dt>{{ label }}</dt><dd>¥{{ displayCents(amount) }}</dd></div>
          <div><dt>新登记会员（不含期初）</dt><dd>{{ result.summary.newActiveMemberCount }} 人</dd></div>
          <div><dt>消费笔数 / 人数</dt><dd>{{ result.summary.consumeCount }} / {{ result.summary.consumeMemberCount }}</dd></div>
        </dl>
      </div>
      <div class="book-panel book-stack">
        <h3>当前在用余额</h3>
        <p>{{ result.balances.memberCount }} 人：欠款 {{ result.balances.debtCount }}，余额为零 {{ result.balances.zeroCount }}，0–50 元（不含零）{{ result.balances.lowCount }}，高于 50 元 {{ result.balances.fundedCount }}。</p>
        <p>储值 ¥{{ displayCents(result.balances.storedCents) }} · 欠款余额 ¥{{ displayCents(result.balances.debtCents) }}</p>
      </div>
      <div class="book-panel book-stack">
        <h3>{{ result.trendUnit === 'month' ? '月' : '日' }}趋势</h3>
        <div class="book-scroll">
          <table><thead><tr><th>期间</th><th>净充值到账</th><th>净消费</th><th>余额变化</th></tr></thead>
            <tbody><tr v-for="row in result.trend" :key="row.date"><td>{{ row.date }}</td><td>{{ displayCents(row.netRechargeCreditCents) }}</td><td>{{ displayCents(row.netConsumptionCents) }}</td><td>{{ displayCents(row.netChangeCents) }}</td></tr></tbody>
          </table>
        </div>
      </div>
      <div class="book-panel book-stack">
        <h3>净消费前十</h3>
        <p v-if="!result.ranking.length">期间没有可列入排行的净消费。</p>
        <ol v-else class="book-list"><li v-for="row in result.ranking" :key="row.memberId"><span>{{ row.name }}</span><strong>¥{{ displayCents(row.netConsumptionCents) }}</strong></li></ol>
      </div>
      <div class="book-panel book-stack">
        <h3>成交明细汇总</h3>
        <label>分组<select v-model="kind" @change="breakdown.load()"><option value="payment">付款方式</option><option value="service">服务项目</option></select></label>
        <p v-if="breakdown.error.value" role="alert">{{ breakdown.error.value }}</p>
        <p v-else-if="breakdown.busy.value" role="status">正在查询明细…</p>
        <p v-else-if="!breakdown.rows.value.length">没有符合期间的成交明细。</p>
        <div v-else class="book-scroll"><table><thead><tr><th>名称</th><th v-if="kind === 'service'">净数量</th><th>净额（元）</th></tr></thead>
          <tbody><tr v-for="row in breakdown.rows.value" :key="row.name + ':' + (row.serviceId || '')"><td>{{ row.name }}</td><td v-if="kind === 'service'">{{ row.quantity }}</td><td>{{ displayCents(row.amountCents) }}</td></tr></tbody>
        </table></div>
        <div class="book-actions">
          <button v-if="breakdown.cursor.value" type="button" @click="breakdown.load()">回到第一页</button>
          <button v-if="breakdown.next.value" type="button" @click="breakdown.load(breakdown.next.value)">下一页明细</button>
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
  return row ? [['充值实收', row.actualPayCents], ['赠送', row.giftCents], ['充值到账毛额', row.rechargeCreditCents],
    ['冲正实收', row.reversedActualPayCents], ['冲正赠送', row.reversedGiftCents], ['净充值到账', row.netRechargeCreditCents],
    ['消费毛额', row.consumptionCents], ['冲正消费', row.reversedConsumptionCents], ['净消费', row.netConsumptionCents],
    ['消费均额（毛额）', row.averageConsumeCents], ['余额净变化', row.netChangeCents]] : [];
});
async function load() {
  const request = ++sequence; loading.value = true; result.value = null; error.value = '';
  try {
    const value = await props.workspace.read('reportBusiness', { ...scope, offsetMinutes: BUSINESS_OFFSET });
    if (request === sequence) { result.value = value; void breakdown.load(); }
  } catch (cause) { if (request === sequence) error.value = cause.message; }
  finally { if (request === sequence) loading.value = false; }
}
function refresh() { try { scope = businessDays(first.value, last.value); void load(); } catch (cause) { error.value = cause.message; } }
watch(() => props.workspace.state.revision, () => { if (props.workspace.state.book) void load(); }, { immediate: true });
</script>
