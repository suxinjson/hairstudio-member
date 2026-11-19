<template>
  <section id="ledger-reports" role="tabpanel" aria-labelledby="ledger-reports-tab" class="business-reports">
    <div class="report-heading">
      <div><h2>经营报表</h2><p>用账本记录，看清日常经营</p></div>
      <label><span class="sr-only">统计周期</span><select v-model="period" aria-label="报表统计周期">
        <option value="today">今天</option><option value="yesterday">昨天</option><option value="week">近7天</option>
        <option value="month">本月</option><option value="last30">近30天</option><option value="custom">自选日期</option>
      </select></label>
    </div>
    <div v-if="period === 'custom'" class="report-date-range">
      <label>开始日期<input v-model="customStart" type="date" aria-label="报表开始日期" /></label>
      <label>结束日期<input v-model="customEnd" type="date" aria-label="报表结束日期" /></label>
    </div>
    <p v-if="reportState.error" role="alert" class="report-error">{{ reportState.error }}</p>
    <template v-if="report">
      <p class="report-range-label">{{ report.startDate }} — {{ report.endDate }}<span>单位：元</span></p>
      <div class="report-kpis">
        <article><p>充值入账额度</p><strong>¥{{ formatCent(report.summary.rechargeCredit) }}</strong><small>{{ report.summary.rechargeCount }} 笔 · 含赠送额度</small></article>
        <article><p>消费扣款金额</p><strong>¥{{ formatCent(report.summary.consumeAmount) }}</strong><small>{{ report.summary.consumeCount }} 笔 · {{ report.summary.consumeMembers }} 位会员</small></article>
        <article><p>平均每笔消费</p><strong>¥{{ formatCent(report.summary.averageConsume) }}</strong><small>有效消费金额 ÷ 笔数</small></article>
        <article><p>新增在用会员</p><strong>{{ report.summary.newActiveMembers }}<em> 人</em></strong><small>所选周期内登记，当前在用</small></article>
      </div>

      <section class="report-card" aria-labelledby="report-trend-title">
        <div class="report-card-heading"><h3 id="report-trend-title">充值与消费趋势</h3><span>按{{ report.trendUnit }}汇总</span></div>
        <div class="report-legend"><span><i class="recharge-line"></i>充值入账</span><span><i class="consume-line"></i>消费扣款</span></div>
        <svg v-if="report.summary.rechargeCount || report.summary.consumeCount" class="report-trend-chart" viewBox="0 0 360 210" role="img" aria-labelledby="report-chart-title report-chart-desc">
          <title id="report-chart-title">所选周期充值与消费趋势</title><desc id="report-chart-desc">绿色为充值入账额度，蓝色为消费扣款金额。完整金额可展开下方每日明细查看。</desc>
          <g v-for="ratio in [0, 0.5, 1]" :key="ratio">
            <line x1="54" x2="344" :y1="y(chartMax * ratio)" :y2="y(chartMax * ratio)" stroke="#e6ece9" />
            <text x="46" :y="y(chartMax * ratio) + 4" text-anchor="end">{{ axisAmount(chartMax * ratio) }}</text>
          </g>
          <polyline :points="points('rechargeCredit')" fill="none" stroke="#167c68" stroke-width="2.5" stroke-linejoin="round" />
          <polyline :points="points('consumeAmount')" fill="none" stroke="#577fbd" stroke-width="2.5" stroke-linejoin="round" />
          <g v-for="(day, index) in report.trend" :key="day.date">
            <circle :cx="x(index)" :cy="y(day.rechargeCredit)" r="2.5" fill="#167c68"><title>{{ day.date }} 充值入账 ¥{{ formatCent(day.rechargeCredit) }}</title></circle>
            <circle :cx="x(index)" :cy="y(day.consumeAmount)" r="2.5" fill="#577fbd"><title>{{ day.date }} 消费扣款 ¥{{ formatCent(day.consumeAmount) }}</title></circle>
            <text v-if="showTick(index)" :x="x(index)" y="192" :text-anchor="index === 0 ? 'start' : index === report.trend.length - 1 ? 'end' : 'middle'">{{ day.label }}</text>
          </g>
        </svg>
        <p v-else class="report-empty">这段时间暂无有效充值或消费记录</p>
        <details class="report-daily-details"><summary>查看每日明细<ChevronDown :size="15" aria-hidden="true" /></summary>
          <div class="report-table-scroll" tabindex="0" role="region" aria-label="每日交易汇总表，可滚动">
            <table><caption class="sr-only">所选周期每日有效充值和消费汇总，单位元</caption><thead><tr><th scope="col">日期</th><th scope="col">充值入账</th><th scope="col">消费扣款</th><th scope="col">消费笔数</th></tr></thead>
              <tbody><tr v-for="day in report.daily" :key="day.date"><th scope="row">{{ day.date }}</th><td>{{ formatCent(day.rechargeCredit) }}</td><td>{{ formatCent(day.consumeAmount) }}</td><td>{{ day.consumeCount }}</td></tr></tbody>
            </table>
          </div>
        </details>
      </section>

      <section class="report-card" aria-labelledby="report-reconcile-title">
        <div class="report-card-heading"><h3 id="report-reconcile-title">交易核对</h3><span>所选周期</span></div>
        <dl class="report-reconcile">
          <div><dt>有效交易</dt><dd>{{ report.summary.rechargeCount + report.summary.consumeCount }} 笔</dd></div>
          <div><dt>撤销冲正</dt><dd>{{ report.summary.reversalCount }} 笔</dd></div>
          <div><dt>已排除撤销原单</dt><dd>{{ report.summary.reversedOriginalCount }} 笔</dd></div>
          <div><dt>账面净变动</dt><dd>{{ report.summary.balanceChange > 0 ? '+' : report.summary.balanceChange < 0 ? '−' : '' }}¥{{ formatCent(Math.abs(report.summary.balanceChange)) }}</dd></div>
        </dl>
        <p class="report-note">账面净变动包含本期全部充值、扣款及冲正，是会员账面余额的变动，不是现金收入。</p>
      </section>

      <section class="report-card" aria-labelledby="report-ranking-title">
        <div class="report-card-heading"><h3 id="report-ranking-title">会员消费排行</h3><span>前10名 · 按金额</span></div>
        <ol v-if="report.ranking.length" class="report-ranking">
          <li v-for="(member, index) in report.ranking" :key="member.id"><span class="report-rank">{{ index + 1 }}</span><span class="report-ranked-member"><strong>{{ member.name }}</strong><small>{{ member.count }} 笔消费</small></span><b>¥{{ formatCent(member.amount) }}</b></li>
        </ol>
        <p v-else class="report-empty">这段时间暂无有效消费记录</p>
      </section>

      <section class="report-card" aria-labelledby="report-balances-title">
        <div class="report-card-heading"><h3 id="report-balances-title">会员余额分布</h3><span>当前在用会员</span></div>
        <dl class="report-balance-totals"><div><dt>可用余额合计</dt><dd>¥{{ formatCent(report.balances.credit) }}</dd></div><div><dt>待收欠款合计</dt><dd>¥{{ formatCent(report.balances.debt) }}</dd></div></dl>
        <ul class="report-balance-groups"><li><span>余额高于50元</span><strong>{{ report.balances.fundedCount }} 人</strong></li><li><span>余额大于0且不超过50元</span><strong>{{ report.balances.lowCount }} 人</strong></li><li><span>零余额</span><strong>{{ report.balances.zeroCount }} 人</strong></li><li><span>有欠款</span><strong>{{ report.balances.debtCount }} 人</strong></li></ul>
        <p class="report-note">共 {{ report.balances.memberCount }} 位在用会员。余额为当前快照，不随统计周期改变。</p>
      </section>
      <details class="report-methodology"><summary>统计口径与说明</summary><p>充值入账包含开卡存入及赠送额度，不等同于实收营业额。消费按会员扣款记账，不代表利润。周期汇总、趋势和排行均排除已撤销原单及冲正记录；跨期撤销也会从原周期的有效交易中排除。交易核对按实际记录时间统计，账面净变动包含冲正。日期按当前设备的本地时间计算；新增在用会员不含已注销档案，历史消费排行仍保留其有效交易。报表使用完整账本，不受会员搜索与交易筛选影响。</p></details>
    </template>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue';
import { ChevronDown } from 'lucide-vue-next';
import { buildBusinessReport, reportDateRange } from '../business-reports.js';
const props = defineProps({
  ledgers: { type: Array, default: () => [] }, members: { type: Array, default: () => [] },
  now: { type: Date, default: () => new Date() }, formatCent: { type: Function, required: true }
});
const period = ref('month');
const initialRange = reportDateRange('month', props.now);
const customStart = ref(initialRange.startDate), customEnd = ref(initialRange.endDate);
const reportState = computed(() => {
  const range = period.value === 'custom' ? { startDate: customStart.value, endDate: customEnd.value } : reportDateRange(period.value, props.now);
  try { return { report: buildBusinessReport({ ...range, ledgers: props.ledgers, members: props.members }) }; }
  catch (error) { return { error: error.message }; }
});
const report = computed(() => reportState.value.report);
const chartMax = computed(() => Math.max(100, ...(report.value?.trend || []).flatMap(day => [day.rechargeCredit, day.consumeAmount])));
const x = index => report.value.trend.length === 1 ? 199 : 54 + index * 290 / (report.value.trend.length - 1);
const y = amount => 164 - amount / chartMax.value * 144;
const points = field => report.value.trend.map((day, index) => x(index) + ',' + y(day[field])).join(' ');
const showTick = index => index === 0 || index === report.value.trend.length - 1 || index % Math.max(1, Math.ceil((report.value.trend.length - 1) / 3)) === 0;
const axisAmount = value => value >= 1000000 ? Math.round(value / 100000) / 10 + '万' : Math.round(value / 100).toLocaleString('zh-CN');
</script>
