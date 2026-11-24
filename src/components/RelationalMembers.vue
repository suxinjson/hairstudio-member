<template>
  <section class="customers-page space-y-3" aria-label="会员档案">
    <!-- 顶部统计与提示 -->
    <div class="customer-list-heading flex items-center justify-between px-1" aria-live="polite">
      <h2 class="text-base font-extrabold text-slate-800 flex items-center gap-1.5 m-0">
        <span>{{ query.trim() ? '搜索 · ' : '' }}{{ currentFilterLabel }}</span>
        <span class="text-xs font-bold text-emerald-800 bg-emerald-100/80 px-2 py-0.5 rounded-full">
          <template v-if="!query.trim() && balance === 'all'">
            <span v-if="totalCount !== null">共 {{ totalCount }} 人</span>
            <span v-else-if="page.next.value">已加载 {{ page.rows.value.length }} 人</span>
            <span v-else>共 {{ page.rows.value.length }} 人</span>
          </template>
          <template v-else-if="!query.trim() && balance === 'recent'">
            最近 {{ page.rows.value.length }} 人
          </template>
          <template v-else>
            {{ page.rows.value.length }} 人
          </template>
        </span>
      </h2>
      <span class="text-xs text-slate-500 font-medium">
        {{ balance === 'low' ? '余额 0–50 元' : balance === 'recent' ? '按最近消费时间排序' : balance === 'debt' ? '查看待还款会员' : '点会员查看档案' }}
      </span>
    </div>


    <!-- 快捷聚合筛选胶囊栏 (全部会员、最近来店、低余额、欠款会员) -->
    <div class="filter-tabs-row flex gap-1.5 overflow-x-auto pb-0.5 no-scrollbar" role="tablist" aria-label="会员范围筛选">
      <button
        v-for="item in filterOptions"
        :key="item.value"
        type="button"
        role="tab"
        class="filter-tab-pill whitespace-nowrap px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all btn-press shrink-0 flex items-center gap-1"
        :class="balance === item.value ? 'bg-emerald-800 text-white shadow-xs font-black' : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200/80'"
        :aria-selected="balance === item.value"
        @click="setBalanceFilter(item.value)"
      >
        <span>{{ item.label }}</span>
      </button>
    </div>
    <!-- 隐藏兼容测试 select -->
    <label style="display: none;">会员范围<select v-model="balance" @change="search"><option v-for="opt in filterOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option></select></label>

    <p v-if="error" class="book-panel book-alert" role="alert">{{ error }}</p>
    <p v-if="receipt" class="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl text-sm font-semibold" role="status">{{ receipt }}</p>

    <!-- 会员卡片列表 -->
    <div v-if="page.busy.value && !page.rows.value.length" class="customer-empty bg-white rounded-2xl p-8 border border-slate-200 text-center" role="status">
      <div class="text-2xl animate-spin inline-block">⏳</div>
      <p class="text-sm text-slate-500 mt-2 font-medium">正在读取会员资料…</p>
    </div>
    <div v-else-if="!page.rows.value.length" class="customer-empty bg-white rounded-2xl p-8 border border-slate-200 text-center">
      <UsersRound :size="36" class="text-slate-400 mx-auto" aria-hidden="true" />
      <h3 class="text-base font-bold text-slate-800 mt-2">{{ query.trim() ? '未找到符合条件的会员' : balance === 'debt' ? '目前没有欠款会员' : balance === 'low' ? '目前没有低余额会员' : '还没有会员档案' }}</h3>
      <p class="text-xs text-slate-500 mt-1">{{ query.trim() ? '试试姓名、手机号、手机尾号或备注' : '登记会员后即可扣款、充值和记录档案' }}</p>
      <div class="flex items-center justify-center gap-2 mt-3">
        <button v-if="balance !== 'all'" type="button" class="h-10 px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold btn-press" @click="setBalanceFilter('all')">查看全部会员</button>
        <button v-if="canEdit" type="button" class="customer-empty-primary h-10 px-4 bg-emerald-700 active:bg-emerald-800 text-white rounded-xl text-xs font-bold shadow-sm btn-press" :disabled="blocked" aria-label="新增会员" @click="create">＋ 登记新会员</button>
      </div>
    </div>
    <div v-else class="customer-list bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <article
        v-for="member in page.rows.value"
        :key="member.id"
        class="customer-row"
        :class="{ 'customer-row-debt': BigInt(member.balanceCents) < 0n }"
      >
        <button
          type="button"
          class="customer-open cursor-pointer"
          :aria-label="member.name"
          @click="select(member.id)"
        >
          <span class="customer-avatar" aria-hidden="true">
            {{ member.name.charAt(0) }}
          </span>
          <span class="customer-identity">
            <strong>{{ member.name }}</strong>
            <span class="customer-phone">{{ formatPhone(member.phone) || '未留手机号' }}</span>
            <span v-if="member.notes" class="customer-notes" :title="member.notes">{{ member.notes }}</span>
            <span class="customer-visit">{{ visitLabel(member) }}</span>
          </span>
        </button>

        <div class="customer-row-actions">
          <span class="customer-balance-label">
            {{ BigInt(member.balanceCents) < 0n ? '会员欠款' : BigInt(member.balanceCents) <= 5000n ? '低余额' : '可用余额' }}
          </span>
          <strong class="customer-balance" :class="{ 'balance-debt': BigInt(member.balanceCents) < 0n }">
            {{ BigInt(member.balanceCents) < 0n ? '−' : '' }}¥{{ displayCents(member.balanceCents) }}
          </strong>
          <button
            type="button"
            class="customer-consume cursor-pointer"
            :disabled="blocked || !canCashier"
            :aria-label="`为${member.name}扣款`"
            @click.stop="quickSale(member, 'consume')"
          >
            扣款
          </button>
        </div>
      </article>
    </div>

    <!-- 底部滚动自动加载与翻页状态 -->
    <div ref="sentinel" class="customer-pagination-area py-3 text-center space-y-1">
      <div v-if="page.busy.value" class="text-xs text-slate-500 font-bold flex items-center justify-center gap-1.5 py-1">
        <span class="inline-block animate-spin">⏳</span>
        <span>正在加载更多会员…</span>
      </div>
      <div v-else-if="!page.next.value && page.rows.value.length" class="text-xs text-slate-400 font-medium py-1">
        已加载全部会员<template v-if="totalCount !== null">（共 {{ totalCount }} 人）</template><template v-else>（共 {{ page.rows.value.length }} 人）</template>
      </div>
      <div class="flex items-center justify-between text-xs text-slate-400 px-1 pt-1">
        <span class="book-muted">本页 {{ page.rows.value.length }} 条</span>
        <button v-if="page.next.value && !page.busy.value" type="button" class="text-xs text-emerald-700 font-bold hover:underline" @click="page.loadMore()">
          下滑或点击加载更多 ↓
        </button>
      </div>
    </div>

    <!-- ======================================================== -->
    <!-- 会员详情卡片抽屉 (MemberDetailDrawer)                     -->
    <!-- ======================================================== -->
    <div v-if="detail" class="app-modal-backdrop fixed inset-0 bg-black/60 z-40 flex flex-col justify-end animate-fade-in backdrop-blur-xs" @click.self="closeDetail">
      <div class="app-modal-surface member-detail-sheet bg-white rounded-t-[32px] max-h-[92vh] flex flex-col animate-slide-up shadow-2xl max-w-lg mx-auto w-full">
        <!-- 弹窗手柄 -->
        <div class="w-12 h-1 bg-slate-300 rounded-full mx-auto mt-2.5 mb-1 shrink-0"></div>

        <div class="modal-header px-4 py-2.5 border-b border-slate-100 flex items-center justify-between gap-2 shrink-0">
          <div class="member-detail-header-copy flex items-center space-x-3 min-w-0">
            <div class="w-11 h-11 rounded-2xl bg-gradient-to-tr from-emerald-700 to-slate-900 text-white flex items-center justify-center font-black text-xl shadow-xs shrink-0">
              {{ detail.name.charAt(0) }}
            </div>
            <div class="min-w-0">
              <div class="flex items-center gap-1.5">
                <button class="copyable-text font-black text-lg text-slate-900 truncate max-w-[130px] sm:max-w-[180px] whitespace-nowrap text-left" @click.stop="copyField(detail.name, '姓名')" aria-label="复制会员姓名">{{ detail.name }}</button>
                <span class="text-[11px] px-2 py-0.5 rounded-full font-black whitespace-nowrap shrink-0"
                  :class="BigInt(detail.balanceCents) < 0n ? 'bg-rose-100 text-rose-800' : 'bg-emerald-100 text-emerald-800'">
                  {{ BigInt(detail.balanceCents) < 0n ? '尚有欠款' : detail.archivedAt ? '已归档' : '会员档案' }}
                </span>
              </div>
              <button class="copyable-text block text-xs text-slate-700 font-mono font-bold whitespace-nowrap mt-0.5 text-left" @click.stop="copyField(detail.phone, '手机号')" aria-label="复制会员手机号">{{ formatPhone(detail.phone) || '未留手机号' }}</button>
            </div>
          </div>
          <div class="flex items-center space-x-1.5 shrink-0">
            <button v-if="canEdit && !detail.archivedAt" type="button" aria-label="修改档案" class="h-8.5 px-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl font-bold text-xs active:bg-emerald-100 btn-press whitespace-nowrap" @click="edit">
              修改档案
            </button>
            <button type="button" aria-label="收起档案" class="h-8.5 px-3 rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200 flex items-center justify-center text-xs font-bold btn-press shrink-0" @click="closeDetail">
              收起档案
            </button>
          </div>
        </div>

        <div class="member-detail-content flex-1 overflow-y-auto p-3.5 space-y-3">
          <!-- 醒目大额度黑金渐变卡片（紧凑内衬，突出余额与欠款） -->
          <div class="member-balance-panel rounded-3xl p-4 bg-gradient-to-br from-slate-900 via-slate-850 to-slate-900 text-white shadow-md"
            :class="{ 'from-rose-950 to-slate-900 border border-rose-800': BigInt(detail.balanceCents) < 0n }">
            <div class="text-xs sm:text-sm font-black whitespace-nowrap text-slate-300">{{ BigInt(detail.balanceCents) < 0n ? '会员当前欠款' : '当前可用余额' }}</div>
            <div class="text-3xl sm:text-4xl font-black tracking-tight mt-1 tabular-nums whitespace-nowrap">
              {{ BigInt(detail.balanceCents) < 0n ? '−' : '' }}¥ {{ displayCents(detail.balanceCents) }}
            </div>
            <div v-if="BigInt(detail.balanceCents) < 0n" class="mt-2 text-xs font-black text-rose-300 bg-rose-900/60 px-3 py-1.5 rounded-xl border border-rose-700 flex items-center space-x-1">
              <span>⚠️</span>
              <span>待收回欠款 ¥{{ displayCents(detail.balanceCents) }}（充值将自动优先结清欠款）</span>
            </div>

            <div class="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-slate-800/80 text-xs">
              <div>
                <span class="text-slate-400 font-medium">历史累计充值：</span>
                <span class="font-bold tabular-nums">¥{{ displayCents(detailStats.totalRecharge) }}</span>
              </div>
              <div>
                <span class="text-slate-400 font-medium">历史累计消费：</span>
                <span class="font-bold tabular-nums">¥{{ displayCents(detailStats.totalConsume) }}</span>
              </div>
            </div>
          </div>

          <!-- 标签 -->
          <div v-if="detail.tags && detail.tags.length" class="flex flex-wrap gap-1.5">
            <span v-for="tag in detail.tags" :key="tag" class="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold">
              # {{ tag }}
            </span>
          </div>

          <!-- 会员备注与服务偏好 -->
          <div v-if="detail.notes" class="bg-amber-50/90 p-3.5 rounded-2xl border-2 border-amber-300 text-amber-950 shadow-xs">
            <div class="flex items-center space-x-1.5 text-xs font-black text-amber-900 tracking-wide uppercase mb-1">
              <span class="text-base" aria-hidden="true">💇</span>
              <span>会员偏好与备注</span>
            </div>
            <div class="text-sm font-black text-amber-950 leading-relaxed pl-5 break-words">
              {{ detail.notes }}
            </div>
          </div>

          <!-- 近期消费与充值记录 (原汁原味还原历史交易) -->
          <div>
            <div class="text-xs font-black uppercase tracking-wider text-slate-500 mb-1.5 flex items-center justify-between">
              <span>近期消费与充值记录 ({{ detailLedgers.length }})</span>
              <span v-if="loadingLedgers" class="text-xs text-slate-400">读取中…</span>
            </div>

            <div v-if="!loadingLedgers && detailLedgers.length === 0" class="text-sm text-slate-400 py-3 text-center font-bold">
              暂无历史记录
            </div>
            <div v-else class="space-y-2">
              <div 
                v-for="l in detailLedgers" 
                :key="l.id"
                class="bg-slate-50 p-3 rounded-2xl border border-slate-200 flex items-center justify-between text-xs"
              >
                <div class="min-w-0 pr-2">
                  <div class="flex items-center space-x-1.5">
                    <span 
                      class="px-2 py-0.5 rounded-lg text-[11px] font-black shrink-0 whitespace-nowrap"
                      :class="getBadgeClass(l.type)"
                    >
                      {{ getTypeText(l.type) }}
                    </span>
                    <span class="font-black text-slate-800 text-sm truncate max-w-[150px]">{{ l.itemsSummary || l.remark || '无' }}</span>
                  </div>
                  <div class="text-slate-400 mt-1 font-medium whitespace-nowrap">
                    {{ formatTime(l.occurredAt || l.created_at) }}
                  </div>
                </div>

                <div class="text-right shrink-0">
                  <div 
                    class="font-black tabular-nums text-base"
                    :class="BigInt(l.deltaCents || 0) > 0n ? 'text-emerald-600' : 'text-slate-900'"
                  >
                    {{ BigInt(l.deltaCents || 0) > 0n ? '+' : '' }}{{ displayCents(l.deltaCents) }}
                  </div>
                  <div class="text-slate-400 font-medium whitespace-nowrap">
                    <span :class="{ 'text-rose-600 font-bold': BigInt(l.balanceAfterCents || 0) < 0n }">
                      {{ BigInt(l.balanceAfterCents || 0) < 0n ? '欠款' : '余额' }}: ¥{{ displayCents(l.balanceAfterCents) }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 次要操作 -->
          <div class="flex items-center justify-between pt-1">
            <button v-if="feature('cashier')" type="button" aria-label="查看会员流水" class="text-xs font-bold text-emerald-800 hover:underline py-1" @click="$emit('history', detail.id, detail.name)">
              查看此会员历史明细 →
            </button>
            <button v-if="owner && canEdit && detail.balanceCents === '0'" type="button" aria-label="归档" class="text-xs text-rose-500 underline font-bold py-1" @click="archive">
              删除注销此会员档案 (仅限余额为0)
            </button>
          </div>
        </div>

        <!-- 底部快捷充值与扣款 (大按钮52px，通俗明白大白话) -->
        <div v-if="!detail.archivedAt" class="member-detail-actions border-t border-slate-200 bg-white grid grid-cols-2 gap-2.5 p-3 pb-gesture-safe shrink-0">
          <button 
            type="button"
            aria-label="充值"
            :disabled="blocked || !canCashier"
            class="h-13 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-2xl font-black text-base shadow-md shadow-emerald-500/20 flex items-center justify-center space-x-1.5 btn-press"
            @click="openSale('recharge')"
          >
            <span class="detail-action-icon" aria-hidden="true">💳</span>
            <span>{{ BigInt(detail.balanceCents) < 0n ? '充值 / 还款' : '充值' }}</span>
          </button>

          <button 
            type="button"
            aria-label="消费"
            :disabled="blocked || !canCashier"
            class="h-13 bg-gradient-to-r from-rose-500 to-rose-600 hover:from-rose-600 hover:to-rose-700 text-white rounded-2xl font-black text-base shadow-md shadow-rose-500/20 flex items-center justify-center space-x-1.5 btn-press"
            @click="openSale('consume')"
          >
            <span class="detail-action-icon" aria-hidden="true">💳</span>
            <span>消费扣款</span>
          </button>
        </div>
      </div>
    </div>

    <!-- ======================================================== -->
    <!-- 交易抽屉 (RelationalSale: 扣款 / 充值 / 冲正)            -->
    <!-- ======================================================== -->
    <RelationalSale v-if="sale" ref="saleForm" :key="sale.key" v-bind="sale" :workspace="workspace" @close="sale = null" @done="settled" />

    <!-- ======================================================== -->
    <!-- 新增 / 编辑会员表单抽屉                                  -->
    <!-- ======================================================== -->
    <div v-if="editor" class="app-modal-backdrop fixed inset-0 bg-black/60 z-50 flex flex-col justify-end animate-fade-in backdrop-blur-xs" @click.self="editor = null">
      <form class="book-panel book-stack app-modal-surface bg-white rounded-t-[28px] max-w-lg mx-auto w-full p-4 space-y-3" @submit.prevent="saveProfile">
        <div class="flex items-center justify-between pb-2 border-b border-slate-100">
          <h3 class="text-base font-extrabold text-slate-900 m-0">{{ editor.memberId ? '编辑会员档案' : '新增会员 · 初始余额为零' }}</h3>
          <button type="button" aria-label="关闭" class="w-8 h-8 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center font-bold text-sm" @click="editor = null">✕</button>
        </div>

        <div class="space-y-3">
          <label class="block text-xs font-bold text-slate-700">
            姓名 <span class="text-rose-500">*</span>
            <input v-model.trim="editor.name" required maxlength="128" placeholder="会员姓名" class="mt-1 w-full h-11 px-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold focus:bg-white focus:border-emerald-600 outline-none" />
          </label>
          <label class="block text-xs font-bold text-slate-700">
            手机号码
            <input v-model.trim="editor.phone" type="tel" maxlength="64" placeholder="手机号码（选填）" class="mt-1 w-full h-11 px-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold focus:bg-white focus:border-emerald-600 outline-none" />
          </label>
          <label class="block text-xs font-bold text-slate-700">
            标签（以 | 分隔）
            <input v-model.trim="editor.tags" maxlength="1024" placeholder="例如：常剪发 | 熟客" class="mt-1 w-full h-11 px-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold focus:bg-white focus:border-emerald-600 outline-none" />
          </label>
          <label class="block text-xs font-bold text-slate-700">
            备注偏好
            <textarea v-model.trim="editor.notes" rows="2" maxlength="1000" placeholder="发型偏好、染膏色号或特别要求" class="mt-1 w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:bg-white focus:border-emerald-600 outline-none"></textarea>
          </label>
        </div>

        <div v-if="duplicate" class="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 space-y-1">
          <p class="font-bold">有其他同名的在用会员。本次未留手机号，请先核对是否为同一人：</p>
          <ul class="pl-4 list-disc space-y-0.5">
            <li v-for="match in duplicate.matches.slice(0, 3)" :key="match.id">
              {{ match.name }} · {{ match.phone ? '尾号 ' + match.phone.slice(-4) : '未留手机号' }}{{ match.notes ? ' · ' + match.notes.slice(0, 60) : '' }}
            </li>
          </ul>
          <label class="flex items-center gap-2 pt-1 font-bold">
            <input v-model="duplicate.acknowledged" type="checkbox" class="w-4 h-4 rounded text-emerald-600">
            <span>确认确系不同人，登记同名会员</span>
          </label>
        </div>

        <div class="grid grid-cols-2 gap-2 pt-2">
          <button type="button" class="h-11 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs" @click="editor = null">取消</button>
          <button type="submit" class="h-11 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs shadow-sm" :aria-label="duplicate ? '仍然保存' : '保存档案'">
            {{ duplicate ? '仍然保存' : '保存档案' }}
          </button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue';
import { UsersRound } from 'lucide-vue-next';
import { displayCents } from '../relational-presentation.js';
import { useRelationalPage } from '../composables/useRelationalPage.js';
import { memberIdentitySignature } from '../member-identity.js';
import RelationalSale from './RelationalSale.vue';

const props = defineProps({
  workspace: { type: Object, required: true },
  owner: Boolean,
  writable: Boolean,
  cashierWritable: Boolean,
  feature: { type: Function, required: true },
  announce: Function,
  balanceFilter: { type: String, default: 'all' },
  searchQuery: { type: String, default: '' }
});

const emit = defineEmits(['history', 'update:balanceFilter', 'update:searchQuery']);

const filterOptions = [
  { value: 'all', label: '全部会员', description: '查看完整会员名单' },
  { value: 'recent', label: '最近来店', description: '按消费时间，显示最近会员' },
  { value: 'low', label: '低余额', description: '可用余额 0–50 元' },
  { value: 'debt', label: '欠款会员', description: '查看待还款会员' }
];

const balance = ref(props.balanceFilter || 'all');
const query = ref(props.searchQuery || '');
const error = ref('');
const receipt = ref('');
const totalCount = ref(null);
const detail = shallowRef(null);
const detailLedgers = ref([]);
const loadingLedgers = ref(false);
const detailStats = reactive({ totalRecharge: '0', totalConsume: '0' });
const sale = shallowRef(null);
const editor = ref(null);
const duplicate = ref(null);
const sentinel = ref(null);
const saleForm = ref(null);

const canEdit = computed(() => Boolean(props.writable && props.feature('members')));
const canCashier = computed(() => Boolean(props.cashierWritable && props.feature('cashier')));
const blocked = computed(() => Boolean(!props.workspace.state.book || props.workspace.state.pending || props.workspace.state.pendingError));

const currentFilterLabel = computed(() => {
  return filterOptions.find(o => o.value === balance.value)?.label || '全部会员';
});

let criteria = { search: query.value, balance: balance.value };
const page = useRelationalPage(cursor => props.workspace.read('listMembers', {
  ...criteria,
  cursor,
  limit: 30
}));

async function loadTotalCount() {
  if (!props.workspace.state.book) return;
  try {
    const res = await props.workspace.read('listMembers', { balance: 'all', limit: 1 });
    if (res && res.total !== undefined) totalCount.value = res.total;
  } catch {}
}

watch(() => props.balanceFilter, val => {
  if (val && val !== balance.value) {
    balance.value = val;
    criteria = { search: query.value, balance: balance.value };
    void page.load();
  }
});

watch(() => props.searchQuery, val => {
  if (val !== undefined && val !== query.value) {
    query.value = val;
    criteria = { search: query.value, balance: balance.value };
    void page.load();
  }
});

watch([() => props.workspace.state.book, () => props.workspace.state.revision], ([book]) => {
  if (book) {
    criteria = { search: query.value, balance: balance.value };
    void page.load();
    void loadTotalCount();
    if (detail.value) void select(detail.value.id);
  }
}, { immediate: true });

function setBalanceFilter(val) {
  balance.value = val;
  emit('update:balanceFilter', val);
  criteria = { search: query.value, balance: balance.value };
  void page.load();
}

function search() {
  emit('update:searchQuery', query.value);
  criteria = { search: query.value, balance: balance.value };
  void page.load();
}

const formatPhone = value => {
  if (!value) return '';
  const digits = value.replace(/\D/g, '');
  if (digits.length === 11) return digits.replace(/(\d{3})(\d{4})(\d{4})/, '$1 $2 $3');
  return value;
};

function visitLabel(member) {
  const time = member.lastVisitedAt || member.lastConsumeAt || (member.balanceCents !== '0' ? member.updatedAt : null);
  if (!time) return '尚未消费';
  const date = new Date(time), today = new Date();
  if (isNaN(date.getTime())) return '尚未消费';
  const timeStr = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return date.toDateString() === today.toDateString() ? `今天 ${timeStr} 来店`
    : `${date.getFullYear() === today.getFullYear() ? '' : date.getFullYear() + '年'}${date.getMonth() + 1}月${date.getDate()}日来店`;
}

function getBadgeClass(type) {
  if (type === 'consume' || type === 'CONSUME') return 'bg-rose-100 text-rose-800';
  if (type === 'recharge' || type === 'RECHARGE') return 'bg-emerald-100 text-emerald-800';
  return 'bg-purple-100 text-purple-800';
}

function getTypeText(type) {
  if (type === 'consume' || type === 'CONSUME') return '消费';
  if (type === 'recharge' || type === 'RECHARGE') return '充值';
  if (type === 'reversal' || type === 'REVERSAL') return '撤销';
  return '记录';
}

function formatTime(isoOrMs) {
  if (!isoOrMs) return '';
  const d = new Date(isoOrMs);
  if (isNaN(d.getTime())) return '';
  const m = d.getMonth() + 1, day = d.getDate(), h = String(d.getHours()).padStart(2, '0'), min = String(d.getMinutes()).padStart(2, '0');
  return `${m}月${day}日 ${h}:${min}`;
}

async function copyField(text, label) {
  if (!text) return;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      receipt.value = `已复制${label}：${text}`;
      setTimeout(() => { receipt.value = ''; }, 2000);
    }
  } catch {}
}

async function select(id) {
  error.value = '';
  try {
    const member = await props.workspace.read('getMember', id);
    detail.value = member;
    loadingLedgers.value = true;
    detailLedgers.value = [];
    try {
      const res = await props.workspace.read('listLedger', { memberId: id, limit: 15 });
      detailLedgers.value = res.items || [];
      // Calculate totals
      let recharge = 0n, consume = 0n;
      for (const item of detailLedgers.value) {
        const delta = BigInt(item.deltaCents || 0);
        if (item.type === 'recharge') recharge += delta;
        else if (item.type === 'consume') consume += (delta < 0n ? -delta : delta);
      }
      detailStats.totalRecharge = recharge.toString();
      detailStats.totalConsume = consume.toString();
    } catch {
      detailLedgers.value = [];
    } finally {
      loadingLedgers.value = false;
    }
  } catch (err) {
    error.value = err.message;
  }
}

function closeDetail() {
  detail.value = null;
  detailLedgers.value = [];
}

async function openSale(type, member = detail.value) {
  if (!canCashier.value || blocked.value || !member) return;
  error.value = '';
  try {
    const configuration = await props.workspace.read('getConfiguration');
    sale.value = {
      key: `${member.id}-${Date.now()}`,
      type,
      member,
      configuration,
      scope: props.workspace.getScope?.()
    };
  } catch (err) {
    error.value = err.message;
  }
}

function quickSale(member, type) {
  void openSale(type, member);
}

function settled(result, draft, currentMember) {
  sale.value = null;
  receipt.value = (props.workspace.mode === 'cloud' ? '已在本机记账，待云端确认：' : '已确认原单 ') + result.entryId + ' · 余额 ¥' + displayCents(result.balanceAfterCents);
  if (detail.value?.id === currentMember.id) {
    detail.value = { ...detail.value, balanceCents: result.balanceAfterCents, accountVersion: result.accountVersion };
  }
  if (props.announce) {
    try {
      props.announce(draft, currentMember);
    } catch {}
  }
  void page.load();
}

function create() {
  if (!canEdit.value || blocked.value) return;
  duplicate.value = null;
  editor.value = { memberId: '', name: '', phone: '', notes: '', tags: '' };
}

function edit() {
  if (!detail.value || !canEdit.value || blocked.value) return;
  duplicate.value = null;
  editor.value = {
    memberId: detail.value.id,
    expectedVersion: detail.value.version,
    name: detail.value.name,
    phone: detail.value.phone,
    notes: detail.value.notes,
    tags: (detail.value.tags || []).join(' | ')
  };
}

async function saveProfile() {
  if (!editor.value || blocked.value) return;
  const { memberId, expectedVersion, name, phone, notes, tags } = editor.value;
  const scope = props.workspace.getScope?.();
  const data = {
    name,
    phone,
    notes,
    tags: tags.split('|').map(s => s.trim()).filter(Boolean),
    ...(memberId ? { expectedVersion } : {})
  };
  try {
    if (!phone) {
      const res = await props.workspace.read('listMembers', { sameName: name, limit: 4 });
      const matches = (res?.items || []).filter(row => row.id !== memberId);
      const signature = memberIdentitySignature(matches);
      if (matches.length && duplicate.value?.signature !== signature) {
        duplicate.value = { matches, signature };
        return;
      }
    }
    const row = await props.workspace.submit('task', {
      type: memberId ? 'member.update' : 'member.create',
      ...(memberId ? { memberId } : {}),
      data
    }, scope);
    editor.value = null;
    duplicate.value = null;
    if (row) detail.value = row;
    receipt.value = '会员档案已保存。';
    void page.load();
  } catch (err) {
    error.value = err.message;
  }
}

async function archive() {
  if (!detail.value || !props.owner || !canEdit.value || blocked.value) return;
  if (!globalThis.confirm('归档账户为零的会员“' + detail.value.name + '”？历史流水将保留。')) return;
  const memberId = detail.value.id, scope = props.workspace.getScope?.();
  try {
    await props.workspace.submit('task', { type: 'member.archive', memberId, data: {} }, scope);
    closeDetail();
    receipt.value = '会员已归档。';
    void page.load();
  } catch (err) {
    error.value = err.message;
  }
}

// 自动滚动翻页 Observer
let observer = null;
onMounted(() => {
  void loadTotalCount();
  if ('IntersectionObserver' in window && sentinel.value) {
    observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && page.next.value && !page.busy.value) {
        page.loadMore();
      }
    }, { rootMargin: '100px' });
    observer.observe(sentinel.value);
  }
});

onUnmounted(() => {
  if (observer) observer.disconnect();
});

defineExpose({
  hasOpenAction: computed(() => Boolean(sale.value || editor.value || loadingLedgers.value)),
  create,
  goBack: () => {
    if (sale.value) {
      if (saleForm.value?.goBack) {
        saleForm.value.goBack();
      } else {
        sale.value = null;
      }
      return true;
    }
    if (editor.value) {
      editor.value = null;
      return true;
    }
    if (detail.value) {
      closeDetail();
      return true;
    }
    return false;
  }
});
</script>
