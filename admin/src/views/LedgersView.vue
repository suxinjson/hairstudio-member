<template>
  <div class="space-y-4">
    <!-- 顶部操作与筛选栏 -->
    <div class="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-sm flex flex-wrap items-center justify-between gap-4">
      <div class="flex flex-wrap items-center gap-3 flex-1 min-w-[320px]">
        <div class="relative w-72">
          <input
            v-model="searchQuery"
            type="text"
            placeholder="搜索单号、会员姓名、手机号或备注..."
            class="w-full h-10 pl-9 pr-3 bg-slate-50 border border-slate-300 rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-600 transition"
          />
          <span class="absolute left-3 top-2.5 text-slate-400">🔍</span>
          <button
            v-if="searchQuery"
            @click="searchQuery = ''"
            class="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600 text-xs w-5 h-5 flex items-center justify-center rounded-full bg-slate-200"
          >
            ✕
          </button>
        </div>

        <div class="inline-flex p-1 bg-slate-100 rounded-xl text-xs font-bold text-slate-600">
          <button
            v-for="t in typeFilters"
            :key="t.key"
            @click="activeType = t.key"
            class="px-3 py-1.5 rounded-lg transition"
            :class="activeType === t.key ? 'bg-white text-emerald-800 shadow-sm font-black' : 'hover:text-slate-900'"
          >
            {{ t.label }} ({{ t.count }})
          </button>
        </div>
      </div>

      <div class="flex items-center gap-2.5">
        <button
          @click="handleExport"
          class="h-10 px-4 bg-emerald-700 hover:bg-emerald-800 text-white rounded-xl text-xs font-black shadow transition flex items-center gap-1.5"
        >
          <span>📤</span> 导出财务对账 Excel
        </button>
      </div>
    </div>

    <!-- 流水数据表格 -->
    <div class="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse text-sm">
          <thead>
            <tr class="bg-slate-50/80 border-b border-slate-200 text-slate-500 font-bold text-xs uppercase tracking-wider">
              <th class="py-3 px-4 font-bold">交易时间</th>
              <th class="py-3 px-4 font-bold">流水单号</th>
              <th class="py-3 px-4 font-bold">会员姓名</th>
              <th class="py-3 px-4 font-bold">联系电话</th>
              <th class="py-3 px-4 font-bold">业务类型</th>
              <th class="py-3 px-4 font-bold text-right">变动金额</th>
              <th class="py-3 px-4 font-bold text-right">变动后余额</th>
              <th class="py-3 px-4 font-bold">项目明细 / 说明</th>
              <th class="py-3 px-4 font-bold text-right">财务动作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 font-medium">
            <tr v-if="filteredLedgers.length === 0">
              <td colspan="9" class="text-center py-12 text-slate-400">
                暂无符合条件的财务流水记录
              </td>
            </tr>
            <tr
              v-for="item in paginatedLedgers"
              :key="item.id"
              class="hover:bg-slate-50/80 transition"
              :class="{ 'opacity-60 bg-slate-50/50': item.isRefunded }"
            >
              <td class="py-3.5 px-4 font-mono text-xs text-slate-500 whitespace-nowrap">
                {{ formatDateTime(item.created_at) }}
              </td>
              <td class="py-3.5 px-4 font-mono text-xs text-slate-400 truncate max-w-[120px]" :title="item.id">
                {{ item.id }}
              </td>
              <td class="py-3.5 px-4 font-black text-slate-900">
                {{ item.memberName }}
              </td>
              <td class="py-3.5 px-4 font-mono text-xs text-slate-500">
                {{ maskPhone(item.memberPhone) }}
              </td>
              <td class="py-3.5 px-4">
                <span
                  class="px-2 py-0.5 rounded-lg text-xs font-black"
                  :class="{
                    'bg-emerald-100 text-emerald-800': item.type === 'RECHARGE',
                    'bg-slate-100 text-slate-800': item.type === 'CONSUME',
                    'bg-amber-100 text-amber-900': item.type === 'REFUND'
                  }"
                >
                  {{ item.type === 'RECHARGE' ? '充值入账' : item.type === 'REFUND' ? '冲正撤单' : '消费扣款' }}
                </span>
              </td>
              <td class="py-3.5 px-4 text-right font-black tabular-nums whitespace-nowrap">
                <span :class="item.changeAmount > 0 ? 'text-emerald-600' : 'text-slate-900'">
                  {{ item.changeAmount > 0 ? '+' : '' }}{{ formatYuan(item.changeAmount) }} 元
                </span>
              </td>
              <td class="py-3.5 px-4 text-right font-bold tabular-nums text-slate-600 whitespace-nowrap">
                ¥{{ formatYuan(item.balanceAfter) }}
              </td>
              <td class="py-3.5 px-4 text-xs text-slate-500 max-w-xs truncate" :title="item.remark">
                {{ item.remark || '无' }}
              </td>
              <td class="py-3.5 px-4 text-right whitespace-nowrap">
                <button
                  v-if="item.type !== 'REFUND' && !item.isRefunded"
                  @click="confirmRefund(item)"
                  class="px-2.5 py-1 rounded-lg text-xs font-bold text-rose-600 bg-rose-50 border border-rose-200/80 hover:bg-rose-100 transition"
                >
                  撤单冲正
                </button>
                <span v-else-if="item.isRefunded" class="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded">
                  已撤销
                </span>
                <span v-else class="text-slate-300 text-xs">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页控制栏 -->
      <div class="p-3.5 bg-slate-50/80 border-t border-slate-200 flex flex-wrap items-center justify-between text-xs text-slate-500 font-semibold gap-3">
        <div class="flex items-center gap-3">
          <span>共 {{ filteredLedgers.length }} 笔财务记录</span>
          <select
            v-model="pageSize"
            class="h-8 px-2 bg-white border border-slate-300 rounded-lg focus:outline-none"
          >
            <option :value="20">每页 20 笔</option>
            <option :value="50">每页 50 笔</option>
            <option :value="100">每页 100 笔</option>
          </select>
        </div>

        <div class="flex items-center gap-1.5">
          <button
            :disabled="currentPage <= 1"
            @click="currentPage--"
            class="px-3 py-1 rounded-lg bg-white border border-slate-300 disabled:opacity-40"
          >
            上一页
          </button>
          <span class="px-2">第 {{ currentPage }} / {{ totalPages || 1 }} 页</span>
          <button
            :disabled="currentPage >= totalPages"
            @click="currentPage++"
            class="px-3 py-1 rounded-lg bg-white border border-slate-300 disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      </div>
    </div>

    <!-- 冲正撤单二次确认弹窗 -->
    <div v-if="refundingItem" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div class="bg-white rounded-3xl p-6 w-full max-w-sm shadow-2xl border border-slate-100">
        <div class="w-12 h-12 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center text-2xl mb-3">
          ⚠️
        </div>
        <h3 class="text-lg font-black text-slate-900 mb-1">确定要撤销冲正此单吗？</h3>
        <p class="text-xs text-slate-500 mb-4 leading-relaxed">
          撤单后将生成一笔相反的反向流水（退回本金或撤销储值），该动作不可再逆转，并会记录在审计日志中。
        </p>

        <div class="p-3 bg-slate-50 rounded-xl text-xs space-y-1 mb-4">
          <div><span class="text-slate-400">会员：</span><strong class="text-slate-800">{{ refundingItem.memberName }}</strong></div>
          <div><span class="text-slate-400">金额：</span><strong class="text-slate-800">{{ (refundingItem.changeAmount / 100).toFixed(2) }} 元</strong></div>
          <div><span class="text-slate-400">类型：</span><strong class="text-slate-800">{{ refundingItem.type === 'RECHARGE' ? '充值入账' : '消费扣款' }}</strong></div>
          <div><span class="text-slate-400">当前余额：</span>{{ formatYuan(observedBalance) }} 元</div>
          <div :class="refundBalanceAfter < 0 ? 'text-rose-700' : 'text-slate-800'">撤销后余额：{{ formatYuan(refundBalanceAfter) }} 元</div>
        </div>
        <label v-if="refundBalanceAfter < 0" class="flex gap-2 text-xs text-rose-700 mb-4">
          <input v-model="debtAcknowledged" type="checkbox" />
          我已核对，确认撤销后将产生 {{ formatYuan(-refundBalanceAfter) }} 元欠款。
        </label>
        <p v-if="refundError" class="text-xs text-rose-700 mb-4" role="alert">{{ refundError }}</p>

        <div class="flex gap-2.5">
          <button
            @click="refundingItem = null"
            class="flex-1 h-11 rounded-xl bg-slate-100 text-slate-700 font-bold text-sm hover:bg-slate-200"
          >
            取消
          </button>
          <button
            @click="executeRefund"
            :disabled="isSubmitting || (refundBalanceAfter < 0 && !debtAcknowledged)"
            class="flex-1 h-11 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-black text-sm disabled:opacity-50"
          >
            {{ isSubmitting ? '冲正处理中...' : '确认撤单冲正' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { formatYuan, maskPhone } from '../utils/security.js';
import { exportLedgersToExcel } from '../utils/exporter.js';
import { adminApi } from '../api/client.js';
import { useOperationSubmission } from '../composables/useOperationSubmission.js';

const props = defineProps({
  ledgers: { type: Array, default: () => [] },
  members: { type: Array, default: () => [] },
  submitOperations: { type: Function, required: true }
});

const submitOperation = useOperationSubmission(operations => props.submitOperations(operations));

const searchQuery = ref('');
const activeType = ref('all');
const currentPage = ref(1);
const pageSize = ref(20);

const typeFilters = computed(() => [
  { key: 'all', label: '全部流水', count: props.ledgers.length },
  { key: 'CONSUME', label: '消费扣款', count: props.ledgers.filter(l => l.type === 'CONSUME').length },
  { key: 'RECHARGE', label: '充值入账', count: props.ledgers.filter(l => l.type === 'RECHARGE').length },
  { key: 'REFUND', label: '撤单冲正', count: props.ledgers.filter(l => l.type === 'REFUND' || l.isRefunded).length }
]);

const filteredLedgers = computed(() => {
  let list = props.ledgers;

  if (activeType.value !== 'all') {
    if (activeType.value === 'REFUND') {
      list = list.filter(l => l.type === 'REFUND' || l.isRefunded);
    } else {
      list = list.filter(l => l.type === activeType.value && !l.isRefunded);
    }
  }

  const q = searchQuery.value.trim().toLowerCase();
  if (q) {
    list = list.filter(l =>
      (l.id && l.id.toLowerCase().includes(q)) ||
      (l.memberName && l.memberName.toLowerCase().includes(q)) ||
      (l.memberPhone && l.memberPhone.includes(q)) ||
      (l.remark && l.remark.toLowerCase().includes(q))
    );
  }

  return list;
});

const totalPages = computed(() => Math.ceil(filteredLedgers.value.length / pageSize.value));
watch([searchQuery, activeType, pageSize], () => { currentPage.value = 1; });
watch(totalPages, pages => { currentPage.value = Math.min(currentPage.value, Math.max(1, pages)); });

const paginatedLedgers = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value;
  return filteredLedgers.value.slice(start, start + pageSize.value);
});

function handleExport() {
  exportLedgersToExcel(filteredLedgers.value, '梦飞空间财务对账流水明细');
}

function formatDateTime(isoStr) {
  if (!isoStr) return '—';
  try {
    const d = new Date(isoStr);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return isoStr;
  }
}

// 冲正撤销操作
const refundingItem = ref(null);
const isSubmitting = ref(false);
const observedBalance = ref(0);
const debtAcknowledged = ref(false);
const refundError = ref('');
const refundBalanceAfter = computed(() => observedBalance.value - (refundingItem.value?.changeAmount || 0));
watch(() => props.members.find(member => member.id === refundingItem.value?.memberId)?.balance, value => {
  if (value !== undefined && value !== observedBalance.value) { observedBalance.value = value; debtAcknowledged.value = false; }
});

function confirmRefund(item) {
  refundingItem.value = item;
  observedBalance.value = props.members.find(member => member.id === item.memberId)?.balance || 0;
  debtAcknowledged.value = false; refundError.value = '';
}

async function executeRefund() {
  if (!refundingItem.value || isSubmitting.value || (refundBalanceAfter.value < 0 && !debtAcknowledged.value)) return;
  isSubmitting.value = true;
  refundError.value = '';
  try {
    const before = observedBalance.value;
    const account = await adminApi.getAccount();
    const member = account.data.members.find(member => member.id === refundingItem.value.memberId);
    if (!member) throw new Error('关联会员不存在');
    if (member.balance !== before) {
      observedBalance.value = member.balance; debtAcknowledged.value = false;
      throw new Error('会员余额已变化，请重新核对撤销后的余额和欠款');
    }
    await submitOperation('refundLedger', [
      refundingItem.value.id,
      'PC后台管理撤单冲正',
      refundBalanceAfter.value < 0 && debtAcknowledged.value
    ], account.data);
    refundingItem.value = null;
  } catch (error) { refundError.value = error.message; }
  finally {
    isSubmitting.value = false;
  }
}
</script>
