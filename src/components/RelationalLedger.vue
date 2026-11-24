<template>
  <section class="book-stack" aria-label="财务流水">
    <form class="book-panel book-actions" role="search" @submit.prevent="search">
      <label>{{ memberId ? '搜索该会员流水' : '搜索流水' }}<input v-model.trim="query" maxlength="128" placeholder="会员、手机号、项目或单号"></label>
      <label>流水类型<select v-model="kind"><option value="">全部</option><option value="recharge">充值</option><option value="consume">消费</option><option value="reversal">冲正</option></select></label>
      <label>起始日<input v-model="from" type="date"></label>
      <label>结束日<input v-model="to" type="date"></label>
      <button type="submit">查询</button>
      <button v-if="memberId" type="button" @click="$emit('all-members')">查看全部会员</button>
    </form>
    <p v-if="memberId" role="status">当前会员：{{ memberName }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="receipt" role="status">{{ receipt }}</p>
    <RelationalSale v-if="reversing" ref="saleForm" v-bind="reversing" :key="reversing.entry.id" :workspace="workspace" type="reverse" @close="reversing = null" @done="reversed" />
    <p v-if="page.error.value" role="alert">{{ page.error.value }}</p>
    <p v-else-if="page.busy.value" role="status">正在查询流水…</p>
    <div v-else class="book-panel book-stack">
      <p v-if="!page.rows.value.length">没有符合条件的流水。</p>
      <ul v-else class="book-list book-ledger-list">
        <li v-for="entry in page.rows.value" :key="entry.id">
          <div class="book-inline book-between">
            <strong>{{ entry.memberName || memberName || entry.memberId }} · {{ labels[entry.type] }}</strong>
            <strong>¥{{ displayCents(entry.deltaCents) }}</strong>
          </div>
          <p>{{ timestamp(entry.confirmedAt || entry.occurredAt) }} · 余额 ¥{{ displayCents(entry.balanceAfterCents) }}{{ entry.reversed ? ' · 已冲正' : '' }}{{ workspace.mode === 'cloud' && !entry.confirmedAt ? ' · 本地未确认' : '' }}</p>
          <details>
            <summary>成交明细</summary>
            <p class="book-break">单号 {{ entry.id }}</p>
            <p v-if="entry.originalEntryId" class="book-break">原单 {{ entry.originalEntryId }}</p>
            <p v-if="entry.reversalEntryId" class="book-break">冲正单 {{ entry.reversalEntryId }}</p>
            <p v-if="entry.remark" class="book-break">备注 {{ entry.remark }}</p>
            <p v-for="(item, index) in entry.items" :key="'i' + index">{{ item.name }} × {{ item.quantity }}，合计 ¥{{ displayCents(item.lineTotalCents) }}</p>
            <p v-for="(payment, index) in entry.payments" :key="'p' + index">{{ payment.method }} ¥{{ displayCents(payment.amountCents) }}</p>
            <p v-if="entry.recharge">实收 ¥{{ displayCents(entry.recharge.actualPayCents) }}，赠送 ¥{{ displayCents(entry.recharge.giftCents) }}</p>
          </details>
          <div v-if="owner && entry.type !== 'reversal' && !entry.reversed" class="book-actions">
            <button type="button" :disabled="blocked" @click="reverse(entry)">账务冲正</button>
          </div>
        </li>
      </ul>
      <div class="book-actions">
        <button v-if="page.cursor.value" type="button" @click="page.load()">回到第一页</button>
        <button v-if="page.next.value" type="button" @click="page.load(page.next.value)">下一页</button>
        <span class="book-muted">本页 {{ page.rows.value.length }} 条 · 营业日 UTC+8</span>
      </div>
    </div>
  </section>
</template>

<script setup>
import { ref, shallowRef, computed, watch, onScopeDispose } from 'vue';
import { useRelationalPage } from '../composables/useRelationalPage.js';
import { displayCents, businessDays } from '../relational-presentation.js';
import RelationalSale from './RelationalSale.vue';

const props = defineProps({ workspace: Object, owner: Boolean, memberId: String, memberName: String });
defineEmits(['all-members']);
const query = ref(''), kind = ref(''), from = ref(''), to = ref(''), error = ref(''), receipt = ref(''), reversing = shallowRef(null), loading = ref(false);
const saleForm = ref(null), hasOpenAction = computed(() => Boolean(reversing.value || loading.value));
const blocked = computed(() => loading.value || !props.workspace.state.book || props.workspace.state.pending || props.workspace.state.pendingError || props.workspace.state.busy);
const labels = { consume: '消费', recharge: '充值', reversal: '冲正' };
const timestamp = value => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(value));
let criteria = {}, alive = true;
onScopeDispose(() => { alive = false; });
const page = useRelationalPage(cursor => props.workspace.read('listLedger', { ...criteria, memberId: props.memberId || '', cursor, limit: 25 }));
defineExpose({ hasOpenAction, goBack: () => {
  if (reversing.value) { saleForm.value?.goBack(); return true; }
  return loading.value;
} });
watch(() => [props.workspace.state.revision, props.memberId], () => { if (props.workspace.state.book) void page.load(); }, { immediate: true });
function search() {
  error.value = ''; reversing.value = null;
  try {
    criteria = { search: query.value, kind: kind.value, ...(from.value || to.value ? businessDays(from.value, to.value) : {}) };
    void page.load();
  } catch (cause) { error.value = cause.message; }
}
async function reverse(entry) {
  const scope = props.workspace.getScope();
  reversing.value = null; error.value = ''; receipt.value = ''; loading.value = true;
  try {
    const member = await props.workspace.read('getMember', entry.memberId);
    if (alive && scope) reversing.value = { entry, member, scope };
  } catch (cause) { if (alive) error.value = cause.message; }
  finally { loading.value = false; }
}
function reversed(result) {
  reversing.value = null;
  receipt.value = (props.workspace.mode === 'cloud' ? '冲正已在本机记账，待云端确认 · 新单号 ' : '原单冲正已确认 · 新单号 ') + result.entryId;
}
</script>
