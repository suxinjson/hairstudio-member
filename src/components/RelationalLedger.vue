<template>
  <section class="book-stack" aria-label="财务流水">
    <!-- 搜索与筛选面板 -->
    <form class="book-panel book-stack" role="search" @submit.prevent="search" style="padding: 0.875rem 1rem;">
      <div style="position: relative;">
        <input v-model.trim="query" maxlength="128" placeholder="会员、手机号、项目或单号"
          style="width: 100%; height: 2.75rem; padding-left: 2.25rem; border-radius: 0.75rem; background: #f8fafc; border: 1px solid #cbd5e1;">
        <Search :size="17" aria-hidden="true" style="position: absolute; left: 0.75rem; top: 50%; transform: translateY(-50%); color: #94a3b8; pointer-events: none;" />
      </div>

      <div class="book-fields" style="grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));">
        <label>流水类型
          <select v-model="kind">
            <option value="">全部类型</option>
            <option value="recharge">充值</option>
            <option value="consume">消费</option>
            <option value="reversal">冲正</option>
          </select>
        </label>
        <label>起始日<input v-model="from" type="date"></label>
        <label>结束日<input v-model="to" type="date"></label>
      </div>

      <div class="book-actions book-between" style="margin-top: 0.25rem;">
        <div class="book-actions" style="margin: 0; gap: 0.5rem;">
          <button type="submit" class="book-primary" style="min-height: 2.5rem; padding: 0.35rem 1rem;">查询</button>
          <button v-if="memberId" type="button" class="book-btn" @click="$emit('all-members')" style="min-height: 2.5rem;">查看全部会员</button>
        </div>
        <p v-if="memberId" role="status" style="margin: 0; font-size: 0.875rem; color: #155f4d; font-weight: 600;">
          当前筛选：{{ memberName }}
        </p>
      </div>
    </form>

    <p v-if="error" class="book-panel book-alert" role="alert">{{ error }}</p>
    <p v-if="receipt" class="book-panel" style="background: #f0fdf4; border-color: #bbf7d0; color: #166534;" role="status">{{ receipt }}</p>

    <!-- 冲正弹窗 -->
    <RelationalSale v-if="reversing" ref="saleForm" v-bind="reversing" :key="reversing.entry.id" :workspace="workspace" type="reverse" @close="reversing = null" @done="reversed" />

    <p v-if="page.error.value" class="book-panel book-alert" role="alert">{{ page.error.value }}</p>
    <div v-else-if="page.busy.value" class="book-panel book-stack" style="text-align: center; padding: 2rem 1rem;" role="status">
      <div style="font-size: 1.5rem; animation: spin 1s linear infinite; display: inline-block;">⏳</div>
      <p style="margin: 0.5rem 0 0; color: #64748b;">正在查询流水记录…</p>
    </div>
    <div v-else class="book-panel book-stack" style="padding: 0.875rem 1rem;">
      <p v-if="!page.rows.value.length" style="text-align: center; color: #64748b; padding: 2rem 0; margin: 0;">没有符合条件的流水记录。</p>
      
      <!-- 现代化流水卡片列表 -->
      <ul v-else class="book-list book-ledger-list">
        <li v-for="entry in page.rows.value" :key="entry.id" style="border-radius: 1rem; border: 1px solid #e7ecea; background: #ffffff; padding: 0.875rem 1rem; box-shadow: 0 1px 4px rgba(0,0,0,0.02);">
          <div class="book-inline book-between" style="border-bottom: 1px solid #f8fafc; padding-bottom: 0.5rem;">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <span :style="{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: '8px',
                fontSize: '0.75rem', fontWeight: '750',
                background: entry.type === 'recharge' ? '#f0fdf4' : entry.type === 'consume' ? '#fef3c7' : '#faf5ff',
                color: entry.type === 'recharge' ? '#15803d' : entry.type === 'consume' ? '#b45309' : '#7e22ce'
              }">
                {{ labels[entry.type] }}
              </span>
              <strong style="font-size: 1rem; color: #1e293b;">{{ entry.memberName || memberName || entry.memberId }}</strong>
            </div>
            <strong :style="{
              fontSize: '1.15rem', fontWeight: '850',
              color: entry.type === 'recharge' ? '#15803d' : entry.type === 'consume' ? '#e11d48' : '#7e22ce'
            }">
              {{ BigInt(entry.deltaCents) > 0n ? '+' : '' }}¥{{ displayCents(entry.deltaCents) }}
            </strong>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.8125rem; color: #64748b; padding-top: 0.25rem;">
            <span>{{ timestamp(entry.confirmedAt || entry.occurredAt) }} · 变动后余额 ¥{{ displayCents(entry.balanceAfterCents) }}</span>
            <span v-if="entry.reversed" style="color: #dc2626; font-weight: 600;">已冲正</span>
            <span v-else-if="workspace.mode === 'cloud' && !entry.confirmedAt" style="color: #d97706;">本地未确认</span>
          </div>

          <details style="margin-top: 0.35rem; font-size: 0.8125rem; color: #475569; background: #f8fafc; padding: 0.5rem 0.75rem; border-radius: 0.625rem;">
            <summary style="cursor: pointer; font-weight: 600; color: #167c68; user-select: none;">查看成交明细与单号</summary>
            <div style="margin-top: 0.35rem; display: flex; flex-direction: column; gap: 0.2rem;">
              <p class="book-break" style="margin: 0;">单号：{{ entry.id }}</p>
              <p v-if="entry.originalEntryId" class="book-break" style="margin: 0;">原单：{{ entry.originalEntryId }}</p>
              <p v-if="entry.reversalEntryId" class="book-break" style="margin: 0; color: #dc2626;">冲正单：{{ entry.reversalEntryId }}</p>
              <p v-if="entry.remark" class="book-break" style="margin: 0;">备注：{{ entry.remark }}</p>
              <p v-for="(item, index) in entry.items" :key="'i' + index" style="margin: 0;">
                {{ item.name }} × {{ item.quantity }}，合计 ¥{{ displayCents(item.lineTotalCents) }}
              </p>
              <p v-for="(payment, index) in entry.payments" :key="'p' + index" style="margin: 0;">
                {{ payment.method }}：¥{{ displayCents(payment.amountCents) }}
              </p>
              <p v-if="entry.recharge" style="margin: 0; color: #15803d;">
                实收 ¥{{ displayCents(entry.recharge.actualPayCents) }}，赠送 ¥{{ displayCents(entry.recharge.giftCents) }}
              </p>
            </div>
          </details>

          <div v-if="owner && entry.type !== 'reversal' && !entry.reversed" class="book-actions" style="margin-top: 0.35rem; justify-content: flex-end;">
            <button type="button" class="book-btn" :disabled="blocked" aria-label="账务冲正" @click="reverse(entry)"
              style="min-height: 2rem; padding: 0.2rem 0.625rem; font-size: 0.75rem; color: #dc2626; border-color: #fecdd3; background: #fff5f5;">
              账务冲正
            </button>
          </div>
        </li>
      </ul>

      <!-- 分页控制 -->
      <div class="book-actions book-between" style="border-top: 1px solid #f1f5f9; padding-top: 0.75rem; margin-top: 0.25rem;">
        <div class="book-actions" style="margin: 0; gap: 0.5rem;">
          <button v-if="page.cursor.value" type="button" class="book-btn" aria-label="回到第一页" @click="page.load()">回到第一页</button>
          <button v-if="page.next.value" type="button" class="book-btn" aria-label="下一页" @click="page.load(page.next.value)">下一页</button>
        </div>
        <span class="book-muted">本页 {{ page.rows.value.length }} 条 · 营业日 UTC+8</span>
      </div>
    </div>
  </section>
</template>

<script setup>
import { ref, shallowRef, computed, watch, onScopeDispose } from 'vue';
import { Search } from 'lucide-vue-next';
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
defineExpose({
  hasOpenAction,
  goBack: () => {
    if (reversing.value) { saleForm.value?.goBack(); return true; }
    return loading.value;
  }
});

watch(() => [props.workspace.state.revision, props.memberId], () => { if (props.workspace.state.book) void page.load(); }, { immediate: true });

function search() {
  criteria = { search: query.value, kind: kind.value, ...(from.value && to.value ? businessDays(from.value, to.value) : {}) };
  void page.load();
}

async function reverse(entry) {
  if (blocked.value) return;
  error.value = ''; receipt.value = ''; loading.value = true;
  try {
    const member = await props.workspace.read('getMember', entry.memberId);
    if (!alive) return;
    reversing.value = { entry, member, scope: props.workspace.getScope() };
  } catch (cause) {
    if (alive) error.value = cause.message;
  } finally {
    if (alive) loading.value = false;
  }
}

function reversed(result) {
  reversing.value = null;
  receipt.value = '冲正成功，单号 ' + result.entryId + ' · 恢复后余额 ¥' + displayCents(result.balanceAfterCents);
}
</script>
