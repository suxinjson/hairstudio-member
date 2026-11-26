<template>
  <section class="customers-page space-y-3" aria-label="会员档案">
    <div class="member-toolbar">
      <label class="member-range"><span class="sr-only">会员范围</span>
        <select v-model="balance" aria-label="会员范围" @change="setBalanceFilter(balance)">
          <option v-for="opt in filterOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
      </label>
      <span class="member-count" aria-live="polite">{{ page.total.value === null ? `本页 ${page.rows.value.length} 人` : `共 ${page.total.value} 人` }}</span>
    </div>
    <form v-if="showSearch" class="member-search" @submit.prevent="searchLocal">
      <input v-model="query" aria-label="搜索会员" maxlength="128" placeholder="姓名、电话、尾号或备注" type="search" />
      <button type="submit" class="book-primary">查询</button>
      <button v-if="canEdit" type="button" :disabled="blocked" @click="create">登记会员</button>
    </form>
    <p v-if="balance === 'recent'" class="book-hint">最近 12 位有有效消费的会员，按消费时间排序；完整交易可在账务流水查看。</p>
    <p v-else-if="balance === 'archived'" class="book-hint">归档会员已退出在用名单，历史流水保留，可打开档案查看。当前暂不支持恢复原档案；再次登记将创建独立的新档案。</p>
    <p v-else-if="balance === 'low'" class="book-hint">可用余额 0–50 元</p>
    <p v-if="error && !detail && !editor" class="book-panel book-alert" role="alert">{{ error }}</p>
    <p v-if="receipt && !detail" class="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl text-sm font-semibold" role="status">{{ receipt }}</p>
    <p v-if="voiceNotice" class="book-panel" role="status">{{ voiceNotice }}</p>
    <div v-if="page.error.value" class="book-panel book-alert" role="alert">
      <p>{{ page.error.value }}</p>
      <button type="button" :disabled="page.busy.value" @click="page.load()">重试读取会员</button>
    </div>
    <p v-if="loadingLedgers && !detail" class="book-panel" role="status">正在读取会员档案…</p>
    <p v-if="saleLoading" class="book-panel" role="status">正在读取收银规则…</p>

    <!-- 会员卡片列表 -->
    <div v-if="page.busy.value && !page.rows.value.length" class="customer-empty bg-white rounded-2xl p-8 border border-slate-200 text-center" role="status">
      <div class="text-2xl animate-spin inline-block">⏳</div>
      <p class="text-sm text-slate-500 mt-2 font-medium">正在读取会员资料…</p>
    </div>
    <div v-else-if="!page.error.value && !page.rows.value.length" class="customer-empty bg-white rounded-2xl p-8 border border-slate-200 text-center">
      <UsersRound :size="36" class="text-slate-400 mx-auto" aria-hidden="true" />
      <h3 class="text-base font-bold text-slate-800 mt-2">{{ query.trim() ? '未找到符合条件的会员' : balance === 'debt' ? '目前没有欠款会员' : balance === 'low' ? '目前没有低余额会员' : balance === 'recent' ? '暂无有效消费的会员' : balance === 'archived' ? '目前没有已归档会员' : '还没有会员档案' }}</h3>
      <p v-if="query.trim() || balance === 'all'" class="text-xs text-slate-500 mt-1">{{ query.trim() ? '试试姓名、手机号、手机尾号或备注' : '登记会员后即可扣款、充值和记录档案' }}</p>
      <div class="flex items-center justify-center gap-2 mt-3">
        <button v-if="balance !== 'all'" type="button" class="h-10 px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold btn-press" @click="setBalanceFilter('all')">查看全部会员</button>
        <button v-if="canEdit" type="button" class="customer-empty-primary h-10 px-4 bg-emerald-700 active:bg-emerald-800 text-white rounded-xl text-xs font-bold shadow-sm btn-press" :disabled="blocked" aria-label="新增会员" @click="create">＋ 登记新会员</button>
      </div>
    </div>
    <div v-else-if="page.rows.value.length" class="customer-list bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <article
        v-for="member in page.rows.value"
        :key="member.id"
        class="customer-row"
        :class="{ 'customer-row-debt': BigInt(member.balanceCents) < 0n, 'customer-row-large-balance': displayAbsoluteCents(member.balanceCents).length > 10 }"
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
          <strong class="customer-balance" :class="{ 'balance-debt': BigInt(member.balanceCents) < 0n }">
            {{ BigInt(member.balanceCents) < 0n ? '欠款 ' : '' }}¥{{ displayAbsoluteCents(member.balanceCents) }}
          </strong>
          <button
            type="button"
            class="customer-consume cursor-pointer"
            v-if="canCashier"
            :disabled="blocked"
            :aria-label="`为${member.name}扣款`"
            @click.stop="quickSale(member, 'consume')"
          >
            扣款
          </button>
        </div>
      </article>
    </div>

    <nav v-if="page.hasPrevious.value || page.next.value" class="customer-pagination-area member-pagination" aria-label="会员分页">
      <button type="button" :disabled="!page.hasPrevious.value || page.busy.value" @click="navigateMembers('previous')">上一页</button>
      <span aria-live="polite">第 {{ page.pageNumber.value }} 页 · {{ page.rows.value.length }} 人<span v-if="page.busy.value"> · 更新中…</span></span>
      <button type="button" :disabled="!page.next.value || page.busy.value" @click="navigateMembers('next')">下一页</button>
    </nav>
    <p v-if="!page.next.value && page.rows.value.length" class="book-hint">{{ balance === 'recent' ? '已显示当前最近消费名单（最多 12 人）' : '已到当前范围末页' }}</p>

    <!-- ======================================================== -->
    <!-- 会员详情卡片抽屉 (MemberDetailDrawer)                     -->
    <!-- ======================================================== -->
    <div v-if="detail" class="app-modal-backdrop fixed inset-0 bg-black/60 z-40 flex flex-col justify-end animate-fade-in backdrop-blur-xs" @click.self="closeDetail">
      <div class="app-modal-surface member-detail-sheet bg-white rounded-t-[32px] max-h-[92vh] flex flex-col animate-slide-up shadow-2xl max-w-lg mx-auto w-full" role="dialog" aria-modal="true" aria-labelledby="member-detail-title">
        <!-- 弹窗手柄 -->
        <div class="w-12 h-1 bg-slate-300 rounded-full mx-auto mt-2.5 mb-1 shrink-0"></div>

        <header class="member-detail-heading">
          <div class="member-detail-identity">
            <h2 id="member-detail-title">{{ detail.name }} <small v-if="detail.archivedAt">已归档</small></h2>
            <span class="selectable">{{ formatPhone(detail.phone) || '未留手机号' }}</span>
          </div>
          <details class="member-more"><summary aria-label="更多会员操作">更多</summary><div>
            <button type="button" @click="copyField(detail.name, '姓名')">复制姓名</button>
            <button v-if="detail.phone" type="button" @click="copyField(detail.phone, '手机号')">复制手机号</button>
            <button v-if="canEdit && !detail.archivedAt" type="button" aria-label="修改档案" :disabled="blocked" @click="edit">修改档案</button>
          </div></details>
          <button type="button" aria-label="收起档案" class="member-close" @click="closeDetail"><span aria-hidden="true">✕</span><span class="sr-only">收起档案</span></button>
        </header>

        <p v-if="copyNotice" class="mx-4 my-2 text-sm" :class="copyFailed ? 'text-rose-700' : 'text-emerald-800'" :role="copyFailed ? 'alert' : 'status'">{{ copyNotice }}</p>
        <div class="member-detail-content flex-1 overflow-y-auto p-3.5 space-y-3">
          <p v-if="error" class="book-alert" role="alert">{{ error }}</p>
          <p v-if="receipt && receiptMemberId === detail.id" class="book-panel book-success" role="status">{{ receipt }}</p>
          <p v-if="voiceNotice && receiptMemberId === detail.id" role="status">{{ voiceNotice }}</p>
          <!-- 醒目大额度黑金渐变卡片（紧凑内衬，突出余额与欠款） -->
          <div class="member-balance-panel rounded-3xl p-4 bg-gradient-to-br from-slate-900 via-slate-850 to-slate-900 text-white shadow-md"
            :class="{ 'from-rose-950 to-slate-900 border border-rose-800': BigInt(detail.balanceCents) < 0n }">
            <div class="text-xs sm:text-sm font-black whitespace-nowrap text-slate-300">{{ BigInt(detail.balanceCents) < 0n ? '会员当前欠款' : '当前可用余额' }}</div>
            <div class="member-balance-value text-3xl sm:text-4xl font-black tracking-tight mt-1 tabular-nums"
              :class="{ 'member-balance-value-large': displayAbsoluteCents(detail.balanceCents).length > 10 }">
              ¥ {{ displayAbsoluteCents(detail.balanceCents) }}
            </div>
            <div v-if="BigInt(detail.balanceCents) < 0n" class="mt-2 text-xs font-black text-rose-300 bg-rose-900/60 px-3 py-1.5 rounded-xl border border-rose-700 flex items-center space-x-1">
              <span>⚠️</span>
              <span>待收回欠款 ¥{{ displayAbsoluteCents(detail.balanceCents) }}（充值将自动优先结清欠款）</span>
            </div>

            <div v-if="feature('cashier')" class="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-slate-800/80 text-xs">
              <div>
                <span class="text-slate-400 font-medium">累计净充值：</span>
                <span class="font-bold tabular-nums">¥{{ displayCents(detailStats.totalRecharge) }}</span>
              </div>
              <div>
                <span class="text-slate-400 font-medium">累计净消费：</span>
                <span class="font-bold tabular-nums">¥{{ displayCents(detailStats.totalConsume) }}</span>
              </div>
            </div>
            <p v-if="feature('cashier')" class="text-xs text-slate-400 mt-2 mb-0">开账后累计，充值含赠送，均已扣除冲正。</p>
          </div>

          <!-- 标签 -->
          <div v-if="detail.tags && detail.tags.length" class="flex flex-wrap gap-1.5">
            <span v-for="tag in detail.tags" :key="tag" class="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold">
              # {{ tag }}
            </span>
          </div>

          <!-- 会员备注与服务偏好 -->
          <div v-if="detail.notes" class="member-detail-note">
            <small>{{ memberNotesLabel }}</small>
            <p>{{ detail.notes }}</p>
          </div>

          <!-- 近期消费与充值记录 (原汁原味还原历史交易) -->
          <div v-if="feature('cashier')">
            <div v-if="detailError" class="book-alert p-3 rounded-xl mb-2" role="alert">
              <p>{{ detailError }}</p>
              <button type="button" :disabled="loadingLedgers" @click="select(detail.id, { keepOpen: true })">重试读取明细</button>
            </div>
            <div class="text-xs font-black uppercase tracking-wider text-slate-500 mb-1.5 flex items-center justify-between">
              <span>近期消费与充值记录 ({{ Math.min(detailLedgers.length, 5) }})</span>
              <span v-if="loadingLedgers" class="text-xs text-slate-400">读取中…</span>
            </div>

            <div v-if="!loadingLedgers && !detailError && detailLedgers.length === 0" class="text-sm text-slate-400 py-3 text-center font-bold">
              暂无历史记录
            </div>
            <div v-else class="space-y-2">
              <div 
                v-for="l in detailLedgers.slice(0, 5)"
                :key="l.id"
                class="member-history-row bg-slate-50 p-3 rounded-2xl border border-slate-200 flex items-center justify-between text-xs"
                :class="{ 'member-history-row-large': displayCents(l.deltaCents).length > 10 || displayCents(l.balanceAfterCents).length > 10 }"
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
                      {{ BigInt(l.balanceAfterCents || 0) < 0n ? '欠款' : '余额' }}: ¥{{ displayAbsoluteCents(l.balanceAfterCents) }}
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
            <button v-if="owner && canEdit && !detail.archivedAt && detail.balanceCents === '0'" type="button" aria-label="归档" class="text-xs text-rose-500 underline font-bold py-1" @click="archive">
              归档会员（保留历史）
            </button>
          </div>
        </div>

        <!-- 底部快捷充值与扣款 (大按钮52px，通俗明白大白话) -->
        <div v-if="canCashier && !detail.archivedAt" class="member-detail-actions border-t border-slate-200 bg-white grid grid-cols-2 gap-2.5 p-3 pb-gesture-safe shrink-0">
          <button 
            type="button"
            aria-label="充值"
            v-if="canCashier"
            :disabled="blocked"
            class="h-13 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-2xl font-black text-base shadow-md shadow-emerald-500/20 flex items-center justify-center space-x-1.5 btn-press"
            @click="openSale('recharge')"
          >
            <span class="detail-action-icon" aria-hidden="true">💳</span>
            <span>{{ BigInt(detail.balanceCents) < 0n ? '充值 / 还款' : '充值' }}</span>
          </button>

          <button 
            type="button"
            aria-label="消费"
            v-if="canCashier"
            :disabled="blocked"
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
    <RelationalSale v-if="sale" ref="saleForm" :key="sale.key" v-bind="sale" :workspace="workspace" :member-notes-label="memberNotesLabel" @close="sale = null" @done="settled" />

    <!-- ======================================================== -->
    <!-- 新增 / 编辑会员表单抽屉                                  -->
    <!-- ======================================================== -->
    <div v-if="editor" class="app-modal-backdrop fixed inset-0 bg-black/60 z-50 flex flex-col justify-end animate-fade-in backdrop-blur-xs" @click.self="closeEditor">
      <form class="profile-sheet book-panel book-stack app-modal-surface bg-white rounded-t-[28px] max-w-lg mx-auto w-full" role="dialog" aria-modal="true" aria-labelledby="member-editor-title" @submit.prevent="saveProfile" @keydown.enter="nextEditorField">
        <div class="profile-header flex items-center justify-between border-b border-slate-100">
          <h3 id="member-editor-title" class="text-base font-extrabold text-slate-900 m-0">{{ editor.memberId ? '编辑会员档案' : '新增会员 · 初始余额为零' }}</h3>
          <button type="button" aria-label="关闭" :disabled="profileBusy" class="w-11 h-11 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center font-bold text-sm" @click="closeEditor">✕</button>
        </div>
        <div class="profile-content">

        <p v-if="profileError" class="book-alert p-3 rounded-xl" role="alert">{{ profileError }}</p>
        <fieldset :disabled="profileBusy" class="space-y-3 min-w-0">
          <label class="block text-xs font-bold text-slate-700">
            <span class="profile-label">姓名 <span class="text-rose-500">*</span></span>
            <input v-model.trim="editor.name" required maxlength="128" autocomplete="off" enterkeyhint="next" data-initial-focus placeholder="会员姓名" class="mt-1 w-full h-11 px-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold focus:bg-white focus:border-emerald-600 outline-none" />
          </label>
          <label class="block text-xs font-bold text-slate-700">
            <span class="profile-label">手机号码</span>
            <input v-model.trim="editor.phone" type="tel" inputmode="tel" autocomplete="off" enterkeyhint="next" maxlength="64" placeholder="手机号码（选填）" class="mt-1 w-full h-11 px-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold focus:bg-white focus:border-emerald-600 outline-none" />
          </label>
          <label class="block text-xs font-bold text-slate-700">
            <span class="profile-label">标签（以 | 分隔）</span>
            <input v-model.trim="editor.tags" maxlength="1024" autocomplete="off" enterkeyhint="next" placeholder="例如：常剪发 | 熟客" class="mt-1 w-full h-11 px-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold focus:bg-white focus:border-emerald-600 outline-none" />
          </label>
          <label class="block text-xs font-bold text-slate-700">
            <span class="profile-label">{{ memberNotesLabel }}</span>
            <textarea v-model.trim="editor.notes" rows="2" maxlength="1000" placeholder="发型偏好、染膏色号或特别要求" class="mt-1 w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:bg-white focus:border-emerald-600 outline-none"></textarea>
          </label>
        </fieldset>

        <div v-if="duplicate" class="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 space-y-1">
          <p class="font-bold">有其他同名的在用会员。本次未留手机号，请先核对是否为同一人：</p>
          <ul class="pl-4 list-disc space-y-0.5">
            <li v-for="match in duplicate.matches.slice(0, 3)" :key="match.id">
              {{ match.name }} · {{ match.phone ? '尾号 ' + match.phone.slice(-4) : '未留手机号' }}{{ match.notes ? ' · ' + match.notes.slice(0, 60) : '' }}
            </li>
          </ul>
          <label class="flex items-center gap-2 pt-1 font-bold">
            <input v-model="duplicate.acknowledged" type="checkbox" :disabled="profileBusy" class="w-4 h-4 rounded text-emerald-600">
            <span>确认确系不同人，登记同名会员</span>
          </label>
        </div>

        </div>
        <div class="profile-actions grid grid-cols-2 gap-2">
          <button type="button" :disabled="profileBusy" class="h-11 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs" @click="closeEditor">取消</button>
          <button type="submit" :disabled="profileBusy || Boolean(duplicate && !duplicate.acknowledged)" class="book-primary h-11 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs shadow-sm disabled:opacity-50" :aria-label="duplicate ? '仍然保存' : '保存档案'">
            {{ profileBusy ? '保存中…' : duplicate ? '确认并保存' : '保存档案' }}
          </button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue';
import { UsersRound } from 'lucide-vue-next';
import { BUSINESS_OFFSET, displayAbsoluteCents, displayCents } from '../relational-presentation.js';
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
  copyText: Function,
  balanceFilter: { type: String, default: 'all' },
  searchQuery: { type: String, default: '' },
  showSearch: Boolean,
  memberNotesLabel: { type: String, default: '会员偏好与备注' }
});

const emit = defineEmits(['history', 'update:balanceFilter', 'update:searchQuery']);

const filterOptions = [
  { value: 'all', label: '全部会员', description: '查看完整会员名单' },
  { value: 'recent', label: '最近消费', description: '按消费时间，显示最近会员' },
  { value: 'low', label: '低余额', description: '可用余额 0–50 元' },
  { value: 'debt', label: '欠款会员', description: '查看待还款会员' },
  { value: 'archived', label: '已归档会员', description: '保留历史，退出在用名单' }
];

const balance = ref(props.balanceFilter || 'all');
const query = ref(props.searchQuery || '');
const error = ref('');
const receipt = ref('');
const receiptMemberId = ref(null), copyNotice = ref(''), copyFailed = ref(false);
const voiceNotice = ref('');
const detail = shallowRef(null);
const detailLedgers = ref([]);
const loadingLedgers = ref(false);
const detailStats = reactive({ totalRecharge: null, totalConsume: null });
const detailError = ref('');
const sale = shallowRef(null);
const saleLoading = ref(false);
const editor = ref(null);
const profileBusy = ref(false), profileError = ref('');
const duplicate = ref(null);
let alive = true, detailSequence = 0, announcementId = null, saleSequence = 0, copyTimer, searchTimer;
watch(() => editor.value ? [editor.value.memberId, editor.value.name, editor.value.phone, editor.value.notes, editor.value.tags] : null, () => {
  duplicate.value = null;
  profileError.value = '';
}, { flush: 'sync' });
const saleForm = ref(null);

const canEdit = computed(() => Boolean(props.writable && props.feature('members')));
const canCashier = computed(() => Boolean(props.cashierWritable && props.feature('cashier')));
const blocked = computed(() => Boolean(!props.workspace.state.book || props.workspace.state.busy || props.workspace.state.pending || props.workspace.state.pendingError || saleLoading.value));

const currentFilterLabel = computed(() => {
  return filterOptions.find(o => o.value === balance.value)?.label || '全部会员';
});

let criteria = { search: query.value, balance: balance.value };
const page = useRelationalPage(cursor => props.workspace.read('listMembers', {
  ...criteria,
  cursor,
  limit: 30
}), { bounded: true });

async function navigateMembers(direction) {
  if (direction === 'previous') await page.loadPrevious(); else await page.loadMore();
  document.querySelector('.member-toolbar')?.scrollIntoView?.({ block: 'start' });
}
function searchLocal() { emit('update:searchQuery', query.value); criteria = { search: query.value, balance: balance.value }; void page.load(); }

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
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { if (alive) void page.load(); }, 150);
  }
});

watch([() => props.workspace.state.book, () => props.workspace.state.revision], ([book]) => {
  if (book) {
    criteria = { search: query.value, balance: balance.value };
    void page.refresh();
    if (detail.value) void select(detail.value.id, { keepOpen: true });
  } else {
    closeDetail();
  }
}, { immediate: true });

function setBalanceFilter(val) {
  balance.value = val;
  emit('update:balanceFilter', val);
  criteria = { search: query.value, balance: balance.value };
  void page.load();
}

function search() {
  clearTimeout(searchTimer);
  query.value = props.searchQuery || '';
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
  const visitedAt = member.lastVisitedAt || member.lastConsumeAt;
  const date = new Date(visitedAt || '');
  if (!Number.isFinite(date.valueOf())) return '暂无有效消费';
  const shifted = new Date(date.valueOf() + BUSINESS_OFFSET * 60000);
  const today = new Date(Date.now() + BUSINESS_OFFSET * 60000);
  const action = '消费';
  if (shifted.toISOString().slice(0, 10) === today.toISOString().slice(0, 10)) {
    return '今天 ' + String(shifted.getUTCHours()).padStart(2, '0') + ':' + String(shifted.getUTCMinutes()).padStart(2, '0') + ' ' + action;
  }
  return (shifted.getUTCFullYear() === today.getUTCFullYear() ? '' : shifted.getUTCFullYear() + '年') + (shifted.getUTCMonth() + 1) + '月' + shifted.getUTCDate() + '日' + action;
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
  const shifted = new Date(d.valueOf() + BUSINESS_OFFSET * 60000);
  const m = shifted.getUTCMonth() + 1, day = shifted.getUTCDate(), h = String(shifted.getUTCHours()).padStart(2, '0'), min = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${m}月${day}日 ${h}:${min}`;
}

async function copyField(text, label) {
  if (!text) return;
  const selected = detailSequence;
  try {
    if (props.copyText) await props.copyText(text);
    else if (globalThis.navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else throw new Error('暂时无法复制，请长按可复制的文字核对。');
    if (!alive || selected !== detailSequence) return;
    copyFailed.value = false; copyNotice.value = '已复制' + label;
  } catch (cause) { if (alive && selected === detailSequence) { copyFailed.value = true; copyNotice.value = cause.message; } }
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { copyNotice.value = ''; }, 3000);
}

async function select(id, { keepOpen = false } = {}) {
  const request = ++detailSequence;
  const current = () => alive && request === detailSequence;
  error.value = '';
  detailError.value = '';
  loadingLedgers.value = true;
  detailLedgers.value = [];
  detailStats.totalRecharge = null;
  detailStats.totalConsume = null;
  if (!keepOpen || detail.value?.id !== id) detail.value = null;
  try {
    const member = await props.workspace.read('getMember', id);
    if (!current()) return;
    detail.value = member;
    if (!props.feature('cashier')) return;
    const [history, totals] = await Promise.allSettled([
      props.workspace.read('listLedger', { memberId: id, limit: 15 }),
      props.workspace.read('getMemberTotals', id)
    ]);
    if (!current()) return;
    if (history.status === 'fulfilled') detailLedgers.value = history.value.items || [];
    if (totals.status === 'fulfilled') {
      detailStats.totalRecharge = totals.value.netRechargeCents;
      detailStats.totalConsume = totals.value.netConsumptionCents;
    }
    detailError.value = [history, totals].filter(result => result.status === 'rejected').map(result => result.reason.message).join('；');
  } catch (err) {
    if (current()) error.value = err.message;
  } finally {
    if (current()) loadingLedgers.value = false;
  }
}

function closeDetail() {
  detailSequence++;
  saleSequence++; saleLoading.value = false;
  clearTimeout(copyTimer); copyNotice.value = '';
  detail.value = null;
  detailLedgers.value = [];
  detailStats.totalRecharge = null;
  detailStats.totalConsume = null;
  detailError.value = '';
  loadingLedgers.value = false;
}

async function openSale(type, member = detail.value) {
  if (!canCashier.value || blocked.value || !member) return;
  error.value = '';
  const request = ++saleSequence, selected = detailSequence;
  saleLoading.value = true;
  try {
    const configuration = await props.workspace.read('getConfiguration');
    if (!alive || request !== saleSequence || selected !== detailSequence) return;
    sale.value = {
      key: `${member.id}-${Date.now()}`,
      type,
      member,
      configuration,
      scope: props.workspace.getScope?.()
    };
  } catch (err) {
    if (alive && request === saleSequence) error.value = err.message;
  } finally { if (request === saleSequence) saleLoading.value = false; }
}

function quickSale(member, type) {
  void openSale(type, member);
}

function settled(result, draft, currentMember) {
  sale.value = null;
  receiptMemberId.value = currentMember.id;
  receipt.value = currentMember.name + ' · ' + (props.workspace.mode === 'cloud' ? '已在本机记账，待云端确认：' : '已确认原单 ') + result.entryId + ' · 余额 ¥' + displayCents(result.balanceAfterCents);
  if (detail.value?.id === currentMember.id) {
    detail.value = { ...detail.value, balanceCents: result.balanceAfterCents, accountVersion: result.accountVersion };
    void select(currentMember.id, { keepOpen: true });
  }
  voiceNotice.value = '';
  announcementId = result.entryId;
  const failed = () => { if (alive && announcementId === result.entryId) voiceNotice.value = '本次交易已入账，语音播报未成功。'; };
  if (props.announce) {
    try {
      Promise.resolve(props.announce(result, draft, currentMember)).catch(failed);
    } catch { failed(); }
  }
  void page.refresh();
}

function closeEditor() { if (!profileBusy.value) editor.value = null; }
function nextEditorField(event) {
  if (event.isComposing || event.target.tagName !== 'INPUT' || event.target.type === 'checkbox') return;
  const fields = [...event.currentTarget.querySelectorAll('fieldset input, fieldset textarea')].filter(field => !field.disabled);
  const next = fields[fields.indexOf(event.target) + 1];
  if (next) { event.preventDefault(); next.focus(); }
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
  if (!editor.value || blocked.value || profileBusy.value) return;
  const capturedEditor = editor.value;
  const { memberId, expectedVersion, name, phone, notes, tags } = capturedEditor;
  const scope = props.workspace.getScope?.();
  const data = {
    name,
    phone,
    notes,
    tags: tags.split('|').map(s => s.trim()).filter(Boolean),
    ...(memberId ? { expectedVersion } : {})
  };
  profileBusy.value = true;
  profileError.value = '';
  try {
    if (!phone) {
      const res = await props.workspace.read('listMembers', { sameName: name, limit: 4 });
      if (!alive || editor.value !== capturedEditor) return;
      const matches = (res?.items || []).filter(row => row.id !== memberId);
      const signature = memberIdentitySignature(matches);
      if (matches.length && duplicate.value?.signature !== signature) {
        duplicate.value = { matches, signature, acknowledged: false };
        return;
      }
      if (matches.length && !duplicate.value?.acknowledged) {
        profileError.value = '请先核对并勾选同名会员确认。';
        return;
      }
    }
    const row = await props.workspace.submit('task', {
      type: memberId ? 'member.update' : 'member.create',
      ...(memberId ? { memberId } : {}),
      data
    }, scope);
    if (!alive) return;
    editor.value = null;
    duplicate.value = null;
    if (row) { detail.value = row; void select(row.id, { keepOpen: true }); }
    receipt.value = '会员档案已保存。';
    receiptMemberId.value = row?.id || null;
    announcementId = null; voiceNotice.value = '';
    void page.load();
  } catch (err) {
    if (alive) profileError.value = err.message;
  } finally {
    profileBusy.value = false;
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

onUnmounted(() => {
  alive = false;
  detailSequence++;
  saleSequence++;
  clearTimeout(copyTimer); clearTimeout(searchTimer);
});

defineExpose({
  hasOpenAction: computed(() => Boolean(sale.value || saleLoading.value || editor.value || detail.value || loadingLedgers.value)),
  create,
  search,
  goBack: () => {
    if (saleLoading.value) { saleSequence++; saleLoading.value = false; return true; }
    if (sale.value) {
      if (saleForm.value?.goBack) {
        saleForm.value.goBack();
      } else {
        sale.value = null;
      }
      return true;
    }
    if (editor.value) {
      if (profileBusy.value) return true;
      editor.value = null;
      return true;
    }
    if (detail.value || loadingLedgers.value) {
      closeDetail();
      return true;
    }
    return false;
  }
});
</script>

<style scoped>
.member-toolbar, .member-search, .member-pagination { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.member-range { min-width: 0; display: flex; align-items: center; }
.member-range select { min-height: 44px; max-width: 200px; padding: 8px 30px 8px 12px; border: 1px solid #e2e8f0; border-radius: 14px; background: white; color: #1e293b; font-weight: 650; }
.member-count { color: #64748b; font-size: 12px; line-height: 1.5; }
.member-search { flex-wrap: wrap; }
.member-search input { flex: 1; min-width: 140px; padding: 10px; border: 1px solid #e2e8f0; border-radius: 12px; background: white; }
.member-pagination { font-size: 12px; color: #64748b; }
.member-pagination button { min-height: 44px; padding: 8px 14px; border: 1px solid #e2e8f0; border-radius: 12px; background: white; color: #167c68; font-weight: 600; }
.member-pagination button:disabled { opacity: .4; }
.customer-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; padding: 12px; min-height: 100px; }
.customer-row + .customer-row { border-top: 1px solid #e2e8f0; }
.customer-open { display: flex; align-items: center; gap: 12px; min-width: 0; text-align: left; }
.customer-avatar { display: grid; place-items: center; flex: none; width: 34px; height: 34px; border-radius: 11px; color: #167c68; background: #e3f1ec; }
.customer-identity { display: grid; min-width: 0; gap: 4px; }
.customer-identity > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.customer-identity strong { font-size: 17px; font-weight: 650; }
.customer-phone { color: #51626a; font-size: 14px; }
.customer-notes, .customer-visit { color: #64748b; font-size: 12px; }
.customer-row-actions { display: grid; align-content: center; justify-items: end; gap: 4px; min-width: 0; }
.customer-balance { font-size: 19px; font-variant-numeric: tabular-nums; }
.customer-row-debt .customer-balance { color: #b42318; }
.customer-row-large-balance { grid-template-columns: minmax(0, 1fr); }
.customer-row-large-balance .customer-row-actions { display: flex; justify-content: space-between; width: 100%; }
.member-detail-note { border: 1px solid #f5d789; border-radius: 12px; padding: 10px; color: #713f12; background: #fffbeb; }
.member-detail-note small { display: block; font-size: 12px; line-height: 1.5; }
.member-detail-note p { margin: 2px 0 0; font-size: 14px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
@media (max-width: 420px) { .member-search input { flex-basis: 100%; } }
</style>
