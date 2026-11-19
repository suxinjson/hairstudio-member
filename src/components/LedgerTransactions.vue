<template>
  <section id="ledger-transactions" role="tabpanel" aria-labelledby="ledger-transactions-tab" class="ledger-transactions space-y-3">
    <div class="ledger-toolbar">
      <div><h2>交易明细</h2><p>{{ searchQuery ? '搜索结果' : '全部记录' }} · {{ ledgers.length }} 笔</p></div>
      <label class="ledger-type-filter"><span class="sr-only">交易类型</span>
        <select :value="filterType" @change="emit('update:filterType', $event.target.value)" aria-label="筛选交易类型">
          <option value="">全部类型</option><option value="CONSUME">消费扣款</option>
          <option value="RECHARGE">充值入账</option><option value="REFUND">撤销冲正</option>
        </select>
      </label>
    </div>
    <p v-if="!ledgers.length" class="ledger-empty">{{ searchQuery ? '没有找到匹配的交易，请换个姓名、手机号或关键词试试' : '暂无相关交易记录' }}</p>
    <div v-else class="ledger-list">
      <article v-for="item in ledgers" :key="item.id" class="ledger-item-card">
        <div class="ledger-item-main">
          <div class="ledger-item-identity"><span class="ledger-type-badge" :class="getBadgeClass(item.type)">{{ getTypeText(item.type) }}<span v-if="item.type === 'RECHARGE'" class="sr-only">（储值）</span></span><h3>{{ item.memberName }}</h3></div>
          <strong class="ledger-amount" :class="{ 'ledger-amount-credit': item.changeAmount > 0 }">{{ item.changeAmount > 0 ? '+' : '−' }}¥{{ formatCent(Math.abs(item.changeAmount)) }}</strong>
        </div>
        <p v-if="item.remark" class="ledger-item-remark">{{ item.remark }}</p>
        <div class="ledger-item-meta"><time :datetime="item.created_at">{{ formatTime(item.created_at) }}</time><span v-if="item.isRefunded" class="ledger-reversed">已撤销</span></div>
        <details class="ledger-item-details">
          <summary>详情与操作<ChevronDown :size="15" aria-hidden="true" /></summary>
          <dl><div><dt>会员手机</dt><dd>{{ formatPhoneSpaced(item.memberPhone) || '未填写' }}</dd></div>
            <div><dt>{{ item.balanceAfter < 0 ? '变动后欠款' : '变动后余额' }}</dt><dd :class="{ 'balance-debt': item.balanceAfter < 0 }">¥{{ formatCent(Math.abs(item.balanceAfter)) }}</dd></div>
          </dl>
          <div class="ledger-item-actions">
            <button type="button" @click="emit('copy', item.memberName, '会员姓名')"><Copy :size="14" aria-hidden="true" />复制姓名</button>
            <button v-if="item.memberPhone" type="button" @click="emit('copy', item.memberPhone, '会员手机号')">复制手机号</button>
            <button v-if="item.type !== 'REFUND' && !item.isRefunded" type="button" class="ledger-refund" :disabled="!canWrite('refundLedger')" @click="emit('refund', item)">撤销此单</button>
            <span v-else-if="item.isRefunded" class="ledger-reversed">已撤销冲正</span>
          </div>
        </details>
      </article>
    </div>
  </section>
</template>

<script setup>
import { ChevronDown, Copy } from 'lucide-vue-next';
defineProps({
  filterType: { type: String, default: '' },
  ledgers: { type: Array, default: () => [] },
  searchQuery: { type: String, default: '' },
  canWrite: { type: Function, default: () => true },
  getBadgeClass: { type: Function, required: true },
  getTypeText: { type: Function, required: true },
  formatPhoneSpaced: { type: Function, required: true },
  formatCent: { type: Function, required: true },
  formatTime: { type: Function, required: true }
});
const emit = defineEmits(['update:filterType', 'copy', 'refund']);
</script>
