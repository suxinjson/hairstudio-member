<template>
  <div class="space-y-4">
    <!-- 顶部操作与筛选栏 -->
    <div class="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-sm flex flex-wrap items-center justify-between gap-4">
      <!-- 搜索输入框与状态切换 -->
      <div class="flex flex-wrap items-center gap-3 flex-1 min-w-[320px]">
        <div class="relative w-72">
          <input
            v-model="searchQuery"
            type="text"
            placeholder="搜索会员姓名、手机号或备注..."
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

        <!-- 筛选分类按钮组 -->
        <div class="inline-flex p-1 bg-slate-100 rounded-xl text-xs font-bold text-slate-600">
          <button
            v-for="f in filterOptions"
            :key="f.key"
            @click="activeFilter = f.key"
            class="px-3 py-1.5 rounded-lg transition"
            :class="activeFilter === f.key ? 'bg-white text-emerald-800 shadow-sm font-black' : 'hover:text-slate-900'"
          >
            {{ f.label }} ({{ f.count }})
          </button>
        </div>
      </div>

      <!-- 右侧动作按钮 -->
      <div class="flex items-center gap-2.5">
        <!-- 手机号隐私脱敏开关 -->
        <button
          @click="showFullPhone = !showFullPhone"
          class="h-10 px-3 border border-slate-200 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-50 transition flex items-center gap-1.5"
          :title="showFullPhone ? '点击隐藏手机中间4位' : '点击查看完整手机号'"
        >
          <span>{{ showFullPhone ? '👁️' : '🕶️' }}</span>
          <span>{{ showFullPhone ? '手机号已明文' : '手机号已脱敏' }}</span>
        </button>

        <button
          @click="handleExport"
          class="h-10 px-3.5 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-bold transition flex items-center gap-1.5"
        >
          <span>📤</span> 导出当前表格
        </button>

        <button
          @click="emit('switch-tab', 'import-export')"
          class="h-10 px-3.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded-xl text-xs font-bold transition flex items-center gap-1.5"
        >
          <span>📥</span> 批量导入
        </button>

        <button
          @click="openNewModal"
          class="h-10 px-4 bg-emerald-700 hover:bg-emerald-800 text-white rounded-xl text-xs font-black shadow transition flex items-center gap-1.5"
        >
          <span>＋</span> 登记会员
        </button>
      </div>
    </div>

    <!-- 会员大表卡片 -->
    <div class="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse text-sm">
          <thead>
            <tr class="bg-slate-50/80 border-b border-slate-200 text-slate-500 font-bold text-xs uppercase tracking-wider">
              <th class="py-3 px-4 w-12 text-center">
                <input
                  type="checkbox"
                  :checked="isAllSelected"
                  @change="toggleSelectAll"
                  class="rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                />
              </th>
              <th class="py-3 px-4 font-bold">会员姓名</th>
              <th class="py-3 px-4 font-bold">手机号码</th>
              <th class="py-3 px-4 font-bold text-right">卡内可用余额</th>
              <th class="py-3 px-4 font-bold">标签 / 分组</th>
              <th class="py-3 px-4 font-bold">开卡备注</th>
              <th class="py-3 px-4 font-bold">建档时间</th>
              <th class="py-3 px-4 font-bold text-right">管理操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 font-medium">
            <tr v-if="filteredMembers.length === 0">
              <td colspan="8" class="text-center py-12 text-slate-400">
                没有找到符合条件的会员记录
              </td>
            </tr>
            <tr
              v-for="member in paginatedMembers"
              :key="member.id"
              class="hover:bg-slate-50/80 transition"
              :class="{ 'bg-rose-50/40': member.balance < 0 }"
            >
              <td class="py-3.5 px-4 text-center">
                <input
                  type="checkbox"
                  v-model="selectedIds"
                  :value="member.id"
                  class="rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                />
              </td>
              <td class="py-3.5 px-4 font-black text-slate-900">
                <div class="flex items-center gap-2">
                  <span
                    class="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-black"
                    :class="member.balance < 0 ? 'bg-rose-100 text-rose-800' : 'bg-emerald-100 text-emerald-800'"
                  >
                    {{ member.name ? member.name.charAt(0) : '会' }}
                  </span>
                  <span>{{ member.name }}</span>
                </div>
              </td>
              <td class="py-3.5 px-4 font-mono font-bold text-slate-600">
                {{ maskPhone(member.phone, showFullPhone) }}
              </td>
              <td class="py-3.5 px-4 text-right font-black tabular-nums">
                <span
                  :class="member.balance < 0 ? 'text-rose-600 font-black' : member.balance <= 5000 ? 'text-amber-600' : 'text-slate-900'"
                >
                  ¥{{ formatYuan(member.balance) }}
                </span>
                <span v-if="member.balance < 0" class="block text-[10px] text-rose-500 font-bold">已挂账</span>
              </td>
              <td class="py-3.5 px-4 text-xs text-slate-500">
                <span v-if="member.tag || (member.tags && member.tags.length) || member.notes?.startsWith('[')" class="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-semibold">
                  {{ member.tags ? member.tags.join('、') : (member.tag || (/^\[([^\]]+)\]/.exec(member.notes || '')?.[1] || '')) }}
                </span>
                <span v-else class="text-slate-300">—</span>
              </td>
              <td class="py-3.5 px-4 text-xs text-slate-500 max-w-xs truncate" :title="member.notes || member.remark">
                {{ (member.notes ? member.notes.replace(/^\[[^\]]+\]\s*/, '') : member.remark) || '—' }}
              </td>
              <td class="py-3.5 px-4 text-xs text-slate-400 font-mono">
                {{ formatDate(member.created_at) }}
              </td>
              <td class="py-3.5 px-4 text-right whitespace-nowrap">
                <div class="flex items-center justify-end gap-1.5 text-xs font-bold">
                  <button
                    @click="openRechargeModal(member)"
                    class="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-800 hover:bg-emerald-100 transition"
                  >
                    充值
                  </button>
                  <button
                    @click="openEditModal(member)"
                    class="px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 transition"
                  >
                    修改
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页控制栏 -->
      <div class="p-3.5 bg-slate-50/80 border-t border-slate-200 flex flex-wrap items-center justify-between text-xs text-slate-500 font-semibold gap-3">
        <div class="flex items-center gap-3">
          <span>共 {{ filteredMembers.length }} 位会员</span>
          <span v-if="selectedIds.length" class="text-emerald-700 font-bold">已选 {{ selectedIds.length }} 位</span>
          <select
            v-model="pageSize"
            class="h-8 px-2 bg-white border border-slate-300 rounded-lg focus:outline-none"
          >
            <option :value="20">每页 20 条</option>
            <option :value="50">每页 50 条</option>
            <option :value="100">每页 100 条</option>
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

    <!-- 快速充值弹窗 -->
    <div v-if="rechargingMember" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div class="bg-white rounded-3xl p-6 w-full max-w-sm shadow-2xl border border-slate-100">
        <h3 class="text-lg font-black text-slate-900 mb-1">为 {{ rechargingMember.name }} 充值</h3>
        <p class="text-xs text-slate-400 mb-4">当前可用余额：¥{{ formatYuan(rechargingMember.balance) }}</p>

        <div class="space-y-3">
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1">充值本金 (元)</label>
            <input
              v-model="rechargeAmountStr"
              type="number"
              step="0.01"
              placeholder="请输入充值金额"
              class="w-full h-11 px-3 bg-slate-50 border border-slate-300 rounded-xl text-base font-black focus:outline-none focus:border-emerald-600"
            />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1">赠送金 (元，选填)</label>
            <input
              v-model="rechargeGiftStr"
              type="number"
              step="0.01"
              placeholder="0.00"
              class="w-full h-10 px-3 bg-slate-50 border border-slate-300 rounded-xl text-sm font-bold focus:outline-none focus:border-emerald-600"
            />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1">充值备注 (选填)</label>
            <input
              v-model="rechargeRemark"
              type="text"
              placeholder="如：店庆活动赠送"
              class="w-full h-10 px-3 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold focus:outline-none focus:border-emerald-600"
            />
          </div>
        </div>

        <div class="mt-6 flex gap-2.5">
          <button
            @click="rechargingMember = null"
            class="flex-1 h-11 rounded-xl bg-slate-100 text-slate-700 font-bold text-sm hover:bg-slate-200"
          >
            取消
          </button>
          <button
            @click="submitRecharge"
            :disabled="!Number(rechargeAmountStr) || isSubmitting"
            class="flex-1 h-11 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-black text-sm disabled:opacity-50"
          >
            {{ isSubmitting ? '入账中...' : '确认充值' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 登记/修改会员弹窗 -->
    <div v-if="editingMember" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div class="bg-white rounded-3xl p-6 w-full max-w-md shadow-2xl border border-slate-100">
        <h3 class="text-lg font-black text-slate-900 mb-4">{{ editingMember.id ? '修改会员档案' : '登记新会员' }}</h3>

        <div class="space-y-3">
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1">会员姓名 *</label>
            <input
              v-model="editForm.name"
              type="text"
              maxlength="32"
              placeholder="请输入会员姓名"
              class="w-full h-10 px-3 bg-slate-50 border border-slate-300 rounded-xl text-sm font-bold focus:outline-none focus:border-emerald-600"
            />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1">手机号码 *</label>
            <input
              v-model="editForm.phone"
              type="tel"
              maxlength="11"
              placeholder="请输入11位手机号"
              class="w-full h-10 px-3 bg-slate-50 border border-slate-300 rounded-xl text-sm font-mono font-bold focus:outline-none focus:border-emerald-600"
            />
          </div>
          <div v-if="!editingMember.id">
            <label class="block text-xs font-bold text-slate-600 mb-1">初始储值金额 (元，选填)</label>
            <input
              v-model="editForm.initialBalanceStr"
              type="number"
              step="0.01"
              placeholder="0.00"
              class="w-full h-10 px-3 bg-slate-50 border border-slate-300 rounded-xl text-sm font-bold focus:outline-none focus:border-emerald-600"
            />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1">会员标签 / 分组 (选填)</label>
            <input
              v-model="editForm.tag"
              type="text"
              placeholder="如：VIP、常客、烫染年卡"
              class="w-full h-10 px-3 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold focus:outline-none focus:border-emerald-600"
            />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1">备注偏好 (选填)</label>
            <textarea
              v-model="editForm.remark"
              rows="2"
              placeholder="如：喜好修剪发梢，偏好某位发型师"
              class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-medium focus:outline-none focus:border-emerald-600"
            ></textarea>
          </div>
        </div>

        <div v-if="editError" class="mt-3 p-2 bg-rose-50 text-rose-700 text-xs font-bold rounded-lg">
          {{ editError }}
        </div>

        <div class="mt-6 flex gap-2.5">
          <button
            @click="editingMember = null"
            class="flex-1 h-11 rounded-xl bg-slate-100 text-slate-700 font-bold text-sm hover:bg-slate-200"
          >
            取消
          </button>
          <button
            @click="submitMemberForm"
            :disabled="!editForm.name.trim() || !editForm.phone.trim() || isSubmitting"
            class="flex-1 h-11 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-black text-sm disabled:opacity-50"
          >
            {{ isSubmitting ? '保存中...' : '确认保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { formatYuan, maskPhone } from '../utils/security.js';
import { exportMembersToExcel } from '../utils/exporter.js';
import { useOperationSubmission } from '../composables/useOperationSubmission.js';
import { isValidMoney, moneyToCent } from '../../../src/money.js';

const props = defineProps({
  members: { type: Array, default: () => [] },
  submitOperations: { type: Function, required: true }
});

const emit = defineEmits(['switch-tab']);
const submitOperation = useOperationSubmission(operations => props.submitOperations(operations));

const searchQuery = ref('');
const activeFilter = ref('all');
const showFullPhone = ref(false);
const selectedIds = ref([]);
const currentPage = ref(1);
const pageSize = ref(20);

const filterOptions = computed(() => [
  { key: 'all', label: '全部会员', count: props.members.length },
  { key: 'positive', label: '正常余额', count: props.members.filter(m => m.balance > 0).length },
  { key: 'low', label: '低余额 (≤50)', count: props.members.filter(m => m.balance >= 0 && m.balance <= 5000).length },
  { key: 'debt', label: '挂账欠款', count: props.members.filter(m => m.balance < 0).length },
  { key: 'archived', label: '已归档', count: props.members.filter(m => m.isArchived).length }
]);

const filteredMembers = computed(() => {
  let list = props.members;

  // 1. 状态筛选
  if (activeFilter.value === 'positive') list = list.filter(m => m.balance > 0 && !m.isArchived);
  else if (activeFilter.value === 'low') list = list.filter(m => m.balance >= 0 && m.balance <= 5000 && !m.isArchived);
  else if (activeFilter.value === 'debt') list = list.filter(m => m.balance < 0 && !m.isArchived);
  else if (activeFilter.value === 'archived') list = list.filter(m => m.isArchived);
  else list = list.filter(m => !m.isArchived);

  // 2. 搜索查询
  const q = searchQuery.value.trim().toLowerCase();
  if (q) {
    list = list.filter(m =>
      (m.name && m.name.toLowerCase().includes(q)) ||
      (m.phone && m.phone.includes(q)) ||
      (m.notes && m.notes.toLowerCase().includes(q)) ||
      (m.remark && m.remark.toLowerCase().includes(q))
    );
  }

  return list;
});

const totalPages = computed(() => Math.ceil(filteredMembers.value.length / pageSize.value));
watch([searchQuery, activeFilter, pageSize], () => { currentPage.value = 1; });
watch(totalPages, pages => { currentPage.value = Math.min(currentPage.value, Math.max(1, pages)); });

const paginatedMembers = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value;
  return filteredMembers.value.slice(start, start + pageSize.value);
});

const isAllSelected = computed(() => {
  return paginatedMembers.value.length > 0 && paginatedMembers.value.every(m => selectedIds.value.includes(m.id));
});

function toggleSelectAll() {
  if (isAllSelected.value) {
    const pageIds = new Set(paginatedMembers.value.map(m => m.id));
    selectedIds.value = selectedIds.value.filter(id => !pageIds.has(id));
  } else {
    const set = new Set(selectedIds.value);
    paginatedMembers.value.forEach(m => set.add(m.id));
    selectedIds.value = Array.from(set);
  }
}

function handleExport() {
  const target = selectedIds.value.length > 0
    ? props.members.filter(m => selectedIds.value.includes(m.id))
    : filteredMembers.value;
  exportMembersToExcel(target, '梦飞空间会员明细表');
}

function formatDate(isoStr) {
  if (!isoStr) return '—';
  try {
    return new Date(isoStr).toLocaleDateString('zh-CN');
  } catch {
    return isoStr;
  }
}

// 快速充值业务
const rechargingMember = ref(null);
const rechargeAmountStr = ref('');
const rechargeGiftStr = ref('');
const rechargeRemark = ref('');
const isSubmitting = ref(false);

function openRechargeModal(member) {
  rechargingMember.value = member;
  rechargeAmountStr.value = '';
  rechargeGiftStr.value = '';
  rechargeRemark.value = '';
}

async function submitRecharge() {
  if (isSubmitting.value) return;
  const amt = String(rechargeAmountStr.value).trim();
  const giftAmt = String(rechargeGiftStr.value || '0').trim();
  if (!isValidMoney(amt) || moneyToCent(amt) <= 0 || !isValidMoney(giftAmt)) { alert('请输入大于零的充值金额，赠送金额须为非负且最多两位小数'); return; }

  isSubmitting.value = true;
  try {
    await submitOperation('recharge', [{
      memberId: rechargingMember.value.id,
      actualPay: amt,
      giftAmount: giftAmt,
      payMethod: 'PC后台充值',
      remark: rechargeRemark.value.trim() || '后台管理充值'
    }]);
    rechargingMember.value = null;
  } catch (error) {
    alert('充值提交失败：' + error.message);
  } finally {
    isSubmitting.value = false;
  }
}

// 登记 / 修改业务
const editingMember = ref(null);
const editForm = ref({ name: '', phone: '', initialBalanceStr: '', tag: '', remark: '' });
const editError = ref('');

function openNewModal() {
  editingMember.value = {};
  editForm.value = { name: '', phone: '', initialBalanceStr: '', tag: '', remark: '' };
  editError.value = '';
}

function openEditModal(member) {
  editingMember.value = member;
  const noteStr = member.notes || member.remark || '';
  const tagMatch = /^\[([^\]]+)\]\s*(.*)$/.exec(noteStr);
  editForm.value = {
    name: member.name || '',
    phone: member.phone || '',
    initialBalanceStr: '',
    tag: tagMatch ? tagMatch[1] : (member.tags ? member.tags.join('、') : member.tag || ''),
    remark: tagMatch ? tagMatch[2] : noteStr
  };
  editError.value = '';
}

async function submitMemberForm() {
  if (isSubmitting.value) return;
  const name = editForm.value.name.trim();
  const phone = editForm.value.phone.replace(/\D/g, '');

  if (!name) {
    editError.value = '会员姓名不能为空';
    return;
  }
  if (phone.length !== 11) {
    editError.value = '手机号必须为11位数字';
    return;
  }

  isSubmitting.value = true;
  editError.value = '';
  try {
    const tagPart = editForm.value.tag ? editForm.value.tag.trim() : '';
    const remarkPart = editForm.value.remark ? editForm.value.remark.trim() : '';
    const notes = [tagPart ? `[${tagPart}]` : '', remarkPart].filter(Boolean).join(' ');

    if (editingMember.value.id) {
      // 修改已有：两参数 (memberId, patch)
      await submitOperation('updateMember', [
        editingMember.value.id,
        {
          name,
          phone,
          notes
        }
      ]);
    } else {
      // 新建：初始储值金额为元 (initBal)
      const initBal = String(editForm.value.initialBalanceStr || '0').trim();
      await submitOperation('createMember', [{
        name,
        phone,
        initialBalance: initBal,
        notes
      }]);
    }

    editingMember.value = null;
  } catch (err) {
    editError.value = err.message || '操作失败';
  } finally {
    isSubmitting.value = false;
  }
}
</script>
