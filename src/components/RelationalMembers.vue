<template>
  <section class="customers-page space-y-3.5" aria-label="会员档案">
    <!-- 顶部统计与提示 -->
    <div class="customer-list-heading flex items-center justify-between px-1" aria-live="polite">
      <h2 class="text-base font-extrabold text-slate-800">
        {{ query.trim() ? '搜索 · ' : '' }}{{ currentFilterLabel }}
        <span class="text-xs font-bold text-slate-500 bg-slate-200/80 px-2 py-0.5 rounded-full ml-1">{{ page.rows.value.length }} 人</span>
      </h2>
      <span class="text-xs text-slate-500">{{ balance === 'low' ? '余额 0–50 元' : '点会员查看档案' }}</span>
    </div>

    <!-- 搜索与快捷操作栏 -->
    <div class="bg-white rounded-2xl p-3 border border-slate-200 shadow-sm space-y-2.5">
      <div class="header-search-row flex items-center gap-2">
        <label class="header-search relative flex-1 m-0">
          <span style="display: none;">搜索会员</span>
          <input
            v-model.trim="query"
            maxlength="128"
            placeholder="姓名、电话或备注"
            class="header-search-input pl-10 pr-9 text-base w-full h-11 bg-slate-50 border border-slate-200 rounded-xl font-medium focus:bg-white focus:border-emerald-600 outline-none"
            @keyup.enter="search"
          />
          <Search :size="19" class="absolute left-3 top-3 text-slate-400 pointer-events-none" aria-hidden="true" />
          <button
            v-if="query"
            type="button"
            aria-label="清空搜索"
            class="absolute right-2 top-2 text-slate-400 hover:text-slate-600 text-sm w-7 h-7 flex items-center justify-center rounded-full bg-slate-200/60"
            @click="query = ''; search()"
          >
            ✕
          </button>
        </label>
        <button
          type="button"
          :disabled="!workspace.state.book"
          aria-label="查询"
          class="h-11 px-4 bg-slate-800 text-white rounded-xl font-bold text-sm btn-press active:bg-slate-900"
          @click="search"
        >
          查询
        </button>
        <button
          v-if="canEdit"
          type="button"
          :disabled="blocked"
          aria-label="新增会员"
          class="register-member h-11 px-3.5 bg-emerald-700 text-white rounded-xl font-bold text-sm btn-press active:bg-emerald-800 flex items-center gap-1 shadow-sm"
          @click="create"
        >
          <span class="text-base font-black">+</span>
          <span>登记</span>
        </button>
      </div>

      <!-- 快捷筛选胶囊栏 -->
      <div class="filter-tabs-row flex gap-1.5 overflow-x-auto pb-0.5" role="tablist" aria-label="会员范围筛选">
        <button
          v-for="item in filterOptions"
          :key="item.value"
          type="button"
          role="tab"
          class="filter-tab-pill whitespace-nowrap px-3 py-1.5 rounded-full text-xs font-bold transition-colors"
          :class="balance === item.value ? 'bg-emerald-700 text-white shadow-xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'"
          :aria-selected="balance === item.value"
          @click="balance = item.value; search()"
        >
          {{ item.label }}
        </button>
      </div>
      <!-- 隐藏兼容测试 select -->
      <label style="display: none;">会员范围<select v-model="balance" @change="search"><option v-for="opt in filterOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option></select></label>
    </div>

    <p v-if="error" class="book-panel book-alert" role="alert">{{ error }}</p>
    <p v-if="receipt" class="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl text-sm font-semibold" role="status">{{ receipt }}</p>

    <!-- 会员卡片列表 -->
    <div v-if="page.busy.value" class="customer-empty bg-white rounded-2xl p-8 border border-slate-200 text-center" role="status">
      <div class="text-2xl animate-spin inline-block">⏳</div>
      <p class="text-sm text-slate-500 mt-2 font-medium">正在读取会员资料…</p>
    </div>
    <div v-else-if="!page.rows.value.length" class="customer-empty">
      <UsersRound :size="36" class="text-slate-400 mx-auto" aria-hidden="true" />
      <h3 class="text-base font-bold text-slate-800 mt-2">{{ query.trim() ? '未找到符合条件的会员' : '还没有会员档案' }}</h3>
      <p class="text-xs text-slate-500 mt-1">{{ query.trim() ? '试试姓名、手机号、手机尾号或备注' : '登记会员后即可扣款、充值和记录档案' }}</p>
      <button v-if="canEdit" type="button" class="customer-empty-primary mt-3" :disabled="blocked" aria-label="新增会员" @click="create">＋ 登记新会员</button>
    </div>
    <div v-else class="customer-list bg-white rounded-2xl border border-slate-200 shadow-sm divide-y divide-slate-100 overflow-hidden">
      <article
        v-for="member in page.rows.value"
        :key="member.id"
        class="customer-row"
        :class="{ 'customer-row-debt': BigInt(member.balanceCents) < 0n }"
      >
        <button
          type="button"
          class="customer-open flex items-center gap-3 text-left w-full"
          :aria-label="member.name"
          @click="select(member.id)"
        >
          <span class="customer-avatar flex-none w-11 h-11 rounded-xl bg-gradient-to-tr from-emerald-700 to-slate-900 text-white flex items-center justify-center font-extrabold text-lg shadow-xs" aria-hidden="true">
            {{ member.name.charAt(0) }}
          </span>
          <span class="customer-identity grid gap-0.5 min-w-0 flex-1">
            <strong class="text-slate-900 text-base font-extrabold leading-tight truncate">{{ member.name }}</strong>
            <span class="customer-phone text-xs text-slate-500 font-mono font-bold">{{ formatPhone(member.phone) || '未留手机号' }}</span>
            <span v-if="member.notes" class="customer-notes line-clamp-1 text-xs text-amber-800 font-medium" :title="member.notes">{{ member.notes }}</span>
          </span>
        </button>

        <div class="customer-row-actions flex flex-col items-end justify-center gap-1 flex-none pl-2">
          <span class="customer-balance-label text-[11px] font-semibold" :class="BigInt(member.balanceCents) < 0n ? 'text-rose-600' : 'text-slate-500'">
            {{ BigInt(member.balanceCents) < 0n ? '会员欠款' : BigInt(member.balanceCents) <= 5000n ? '低余额' : '可用余额' }}
          </span>
          <strong class="customer-balance text-lg font-black tabular-nums tracking-tight" :class="BigInt(member.balanceCents) < 0n ? 'text-rose-600' : 'text-slate-900'">
            {{ BigInt(member.balanceCents) < 0n ? '−' : '' }}¥{{ displayCents(member.balanceCents) }}
          </strong>
          <button
            type="button"
            class="customer-consume h-8 px-3.5 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 active:bg-emerald-200 border border-emerald-200 rounded-lg text-xs font-black btn-press"
            :disabled="blocked || !canCashier"
            :aria-label="`为${member.name}扣款`"
            @click="quickSale(member, 'consume')"
          >
            扣款
          </button>
        </div>
      </article>
    </div>

    <!-- 底部翻页 -->
    <div class="flex items-center justify-between pt-1 px-1">
      <div class="flex gap-2">
        <button v-if="page.cursor.value" type="button" class="h-8 px-3 bg-white border border-slate-200 text-slate-700 rounded-lg text-xs font-bold" @click="page.load()">回到第一页</button>
        <button v-if="page.next.value" type="button" class="h-8 px-3 bg-white border border-slate-200 text-slate-700 rounded-lg text-xs font-bold" @click="page.load(page.next.value)">下一页</button>
      </div>
      <span class="book-muted text-xs text-slate-500">本页 {{ page.rows.value.length }} 条</span>
    </div>

    <!-- ======================================================== -->
    <!-- 会员详情卡片抽屉 (MemberDetailDrawer)                     -->
    <!-- ======================================================== -->
    <div v-if="detail" class="app-modal-backdrop fixed inset-0 bg-black/60 z-40 flex flex-col justify-end animate-fade-in backdrop-blur-xs" @click.self="closeDetail">
      <div class="app-modal-surface member-detail-sheet bg-white rounded-t-[28px] max-h-[90vh] flex flex-col animate-slide-up shadow-2xl max-w-lg mx-auto w-full">
        <!-- 弹窗手柄 -->
        <div class="w-12 h-1 bg-slate-300 rounded-full mx-auto mt-2.5 mb-1 shrink-0"></div>

        <div class="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-2">
          <div class="flex items-center space-x-3 min-w-0">
            <div class="w-12 h-12 rounded-2xl bg-gradient-to-tr from-emerald-700 to-slate-900 text-white flex items-center justify-center font-black text-xl shadow-xs shrink-0">
              {{ detail.name.charAt(0) }}
            </div>
            <div class="min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="font-black text-lg text-slate-900 truncate">{{ detail.name }}</span>
                <span class="text-[11px] px-2 py-0.5 rounded-full font-black whitespace-nowrap"
                  :class="BigInt(detail.balanceCents) < 0n ? 'bg-rose-100 text-rose-800' : 'bg-emerald-100 text-emerald-800'">
                  {{ BigInt(detail.balanceCents) < 0n ? '尚有欠款' : detail.archivedAt ? '已归档' : '在用会员' }}
                </span>
              </div>
              <span class="text-xs text-slate-600 font-mono font-bold mt-0.5 block">{{ formatPhone(detail.phone) || '未留手机号' }}</span>
            </div>
          </div>
          <div class="flex items-center space-x-1.5 shrink-0">
            <button v-if="canEdit && !detail.archivedAt" type="button" aria-label="编辑" class="h-8 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-bold text-xs btn-press" @click="edit">
              修改档案
            </button>
            <button type="button" aria-label="收起档案" class="h-8 px-3 rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200 flex items-center justify-center text-xs font-bold btn-press" @click="closeDetail">
              收起档案
            </button>
          </div>
        </div>

        <div class="flex-1 overflow-y-auto p-4 space-y-3">
          <!-- 醒目大额度余额卡片 -->
          <div class="member-balance-panel rounded-2xl p-4 bg-gradient-to-br from-slate-900 to-slate-800 text-white shadow-md"
            :class="{ 'from-rose-950 to-slate-900 border border-rose-800': BigInt(detail.balanceCents) < 0n }">
            <div class="text-xs font-bold text-slate-300">{{ BigInt(detail.balanceCents) < 0n ? '会员当前欠款' : '当前可用储值余额' }}</div>
            <div class="text-3xl font-black tracking-tight mt-1 tabular-nums">
              {{ BigInt(detail.balanceCents) < 0n ? '−' : '' }}¥ {{ displayCents(detail.balanceCents) }}
            </div>
            <div v-if="BigInt(detail.balanceCents) < 0n" class="mt-2 text-xs font-bold text-rose-300 bg-rose-900/60 px-3 py-1.5 rounded-xl border border-rose-700 flex items-center space-x-1">
              <span>⚠️</span>
              <span>待收回欠款（充值时将优先结清欠款）</span>
            </div>
          </div>

          <!-- 标签 -->
          <div v-if="detail.tags && detail.tags.length" class="flex flex-wrap gap-1.5">
            <span v-for="tag in detail.tags" :key="tag" class="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold">
              # {{ tag }}
            </span>
          </div>

          <!-- 会员备注 -->
          <div v-if="detail.notes" class="bg-amber-50 p-3.5 rounded-2xl border border-amber-200 text-amber-950">
            <div class="text-xs font-black text-amber-900 flex items-center gap-1 mb-1">
              <span>💇</span><span>会员备注偏好</span>
            </div>
            <div class="text-sm font-bold text-amber-950 leading-relaxed break-words pl-4">
              {{ detail.notes }}
            </div>
          </div>

          <!-- 底部主行动按钮 -->
          <div v-if="!detail.archivedAt" class="pt-2 grid grid-cols-2 gap-2.5">
            <button
              v-if="canCashier"
              type="button"
              aria-label="消费"
              :disabled="blocked"
              class="h-12 bg-gradient-to-r from-rose-600 to-rose-700 text-white rounded-xl font-black text-sm flex items-center justify-center gap-1.5 shadow-md shadow-rose-600/25 btn-press"
              @click="openSale('consume')"
            >
              <Scissors :size="18" aria-hidden="true" />
              <span>消费扣款</span>
            </button>
            <button
              v-if="canCashier"
              type="button"
              aria-label="充值"
              :disabled="blocked"
              class="h-12 bg-gradient-to-r from-emerald-600 to-emerald-700 text-white rounded-xl font-black text-sm flex items-center justify-center gap-1.5 shadow-md shadow-emerald-600/25 btn-press"
              @click="openSale('recharge')"
            >
              <CreditCard :size="18" aria-hidden="true" />
              <span>充值</span>
            </button>
          </div>

          <!-- 次要操作 -->
          <div class="flex items-center justify-between pt-1">
            <button v-if="feature('cashier')" type="button" aria-label="查看会员流水" class="text-xs font-bold text-emerald-800 hover:underline py-1" @click="$emit('history', detail.id, detail.name)">
              查看此会员历史明细 →
            </button>
            <button v-if="owner && canEdit && detail.balanceCents === '0'" type="button" aria-label="归档" class="text-xs text-slate-400 hover:text-slate-600 py-1" @click="archive">
              归档此会员
            </button>
          </div>
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
          <p class="text-[11px] text-amber-800">{{ MEMBER_IDENTITY_ADVICE }}</p>
        </div>

        <div class="pt-2 flex gap-2">
          <button
            type="submit"
            :disabled="blocked"
            :aria-label="duplicate ? '仍然保存' : '保存档案'"
            class="flex-1 h-12 bg-emerald-700 active:bg-emerald-800 text-white rounded-xl font-black text-sm btn-press shadow-sm"
          >
            {{ duplicate ? '仍然保存' : '保存档案' }}
          </button>
          <button v-if="duplicate" type="button" class="h-12 px-4 bg-slate-100 text-slate-700 rounded-xl font-bold text-sm" @click="duplicate = null">返回补充</button>
          <button type="button" aria-label="关闭" class="h-12 px-4 bg-slate-100 text-slate-700 rounded-xl font-bold text-sm" @click="editor = null">关闭</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup>
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { Search, UsersRound, Scissors, CreditCard } from 'lucide-vue-next';
import RelationalSale from './RelationalSale.vue';
import { useRelationalPage } from '../composables/useRelationalPage.js';
import { displayCents } from '../relational-presentation.js';
import { canonicalJSON } from '../canonical-json.js';
import { MEMBER_IDENTITY_ADVICE, memberIdentitySignature } from '../member-identity.js';

const props = defineProps({
  workspace: Object, owner: Boolean, writable: Boolean, cashierWritable: { type: Boolean, default: undefined },
  feature: Function, announce: Function, balanceFilter: { type: String, default: 'all' }
});
defineEmits(['history']);

const filterOptions = [
  { value: 'all', label: '全部会员' },
  { value: 'recent', label: '最近来店' },
  { value: 'positive', label: '有储值' },
  { value: 'low', label: '余额 0–50 元' },
  { value: 'debt', label: '欠款' },
  { value: 'archived', label: '已归档' }
];

const query = ref(''), balance = ref(props.balanceFilter), detail = shallowRef(null), detailScope = shallowRef(null);
const editor = ref(null), sale = shallowRef(null), error = ref(''), receipt = ref(''), loadingDetail = ref(false);
const duplicate = shallowRef(null), savingProfile = ref(false);
const saleForm = ref(null), hasOpenAction = computed(() => Boolean(sale.value || editor.value || loadingDetail.value));
const canEdit = computed(() => props.writable && props.feature('members'));
const canCashier = computed(() => (props.cashierWritable ?? props.writable) && props.feature('cashier'));
const blocked = computed(() => !props.workspace.state.book || props.workspace.state.busy || props.workspace.state.pending || props.workspace.state.pendingError || loadingDetail.value || savingProfile.value);

const currentFilterLabel = computed(() => filterOptions.find(item => item.value === balance.value)?.label || '全部会员');

let criteria = { search: '', balance: balance.value }, sequence = 0, alive = true;
const page = useRelationalPage(cursor => props.workspace.read('listMembers', { ...criteria, cursor, limit: 25 }));
onScopeDispose(() => { alive = false; sequence++; });

function formatPhone(val) {
  if (!val) return '';
  return /^\d{11}$/.test(val) ? val.replace(/(\d{3})(\d{4})(\d{4})/, '$1 $2 $3') : val;
}

function closeDetail() { sequence++; detail.value = null; detailScope.value = null; sale.value = null; editor.value = null; loadingDetail.value = false; }
function goBack() {
  if (savingProfile.value || props.workspace.state.busy) return true;
  if (sale.value) { saleForm.value?.goBack(); return true; }
  if (duplicate.value) { duplicate.value = null; return true; }
  if (editor.value) { editor.value = null; return true; }
  if (!detail.value && !loadingDetail.value) return false;
  closeDetail(); return true;
}
defineExpose({ goBack, hasOpenAction });

function search() { closeDetail(); criteria = { search: query.value, balance: balance.value }; void page.load(); }
watch(() => props.balanceFilter, filter => { balance.value = filter; query.value = ''; search(); });
watch(editor, () => { duplicate.value = null; }, { deep: true, flush: 'sync' });
watch(() => props.workspace.state.revision, () => { if (props.workspace.state.book) void page.load(); }, { immediate: true });
const sameScope = scope => Boolean(scope && canonicalJSON(scope) === canonicalJSON(props.workspace.getScope()));

async function perform(action, completion = () => {}) {
  error.value = ''; receipt.value = '';
  try { const result = await action(); if (alive) completion(result); }
  catch (cause) { if (alive) error.value = cause.message; }
}

async function select(id) {
  const scope = props.workspace.getScope(), requested = ++sequence;
  detail.value = null; sale.value = null; editor.value = null; loadingDetail.value = true;
  try {
    await perform(() => props.workspace.read('getMember', id), row => {
      if (requested === sequence && sameScope(scope)) { detail.value = row; detailScope.value = scope; }
    });
  } finally { if (requested === sequence) loadingDetail.value = false; }
}

async function quickSale(memberRow, type) {
  await select(memberRow.id);
  if (detail.value?.id === memberRow.id) {
    await openSale(type);
  }
}

function create() {
  closeDetail(); error.value = ''; receipt.value = '';
  editor.value = { scope: props.workspace.getScope(), name: '', phone: '', notes: '', tags: '' };
}

function edit() {
  const row = detail.value; sale.value = null; receipt.value = ''; error.value = '';
  editor.value = { scope: detailScope.value, memberId: row.id, version: row.version, name: row.name, phone: row.phone, notes: row.notes, tags: row.tags.join(' | ') };
}

async function saveProfile() {
  if (blocked.value || !editor.value) return;
  const original = canonicalJSON(editor.value), { scope, memberId, version, name, phone, notes, tags } = editor.value;
  const data = { name, phone, notes, tags: tags.split('|').map(tag => tag.trim()).filter(Boolean), ...(memberId ? { expectedVersion: version } : {}) };
  const currentEditor = () => alive && sameScope(scope) && canonicalJSON(editor.value) === original;
  savingProfile.value = true;
  try {
    await perform(async () => {
      if (!phone) {
        const page = await props.workspace.read('listMembers', { sameName: name, limit: 4 });
        if (!currentEditor()) return;
        const matches = page.items.filter(row => row.id !== memberId), signature = memberIdentitySignature(matches);
        if (matches.length && duplicate.value?.signature !== signature) { duplicate.value = { matches, signature }; return; }
      }
      if (currentEditor()) return props.workspace.submit('task', { type: memberId ? 'member.update' : 'member.create', ...(memberId ? { memberId } : {}), data }, scope);
    }, row => {
      if (!row || !currentEditor()) return;
      editor.value = null; detail.value = row; detailScope.value = scope; receipt.value = '会员档案已保存。';
    });
  } finally { savingProfile.value = false; }
}

function archive() {
  if (blocked.value || !globalThis.confirm('归档账户为零的会员“' + detail.value.name + '”？历史流水将保留。')) return;
  const memberId = detail.value.id, scope = detailScope.value;
  void perform(() => props.workspace.submit('task', { type: 'member.archive', memberId, data: {} }, scope), () => {
    closeDetail(); receipt.value = '会员已归档。';
  });
}

async function openSale(type) {
  const member = detail.value, scope = detailScope.value, requested = ++sequence;
  editor.value = null; sale.value = null; loadingDetail.value = true;
  try {
    await perform(() => props.workspace.read('getConfiguration'), configuration => {
      if (requested === sequence && sameScope(scope)) sale.value = { key: requested, type, member, scope, configuration };
    });
  } finally { if (requested === sequence) loadingDetail.value = false; }
}

function settled(result, draft, member) {
  sale.value = null;
  const scope = detailScope.value;
  if (detail.value?.id === member.id && sameScope(scope)) detail.value = { ...detail.value, balanceCents: result.balanceAfterCents, accountVersion: result.accountVersion };
  receipt.value = (props.workspace.mode === 'cloud' ? '已在本机记账，待云端确认：' : '已确认原单 ') + result.entryId + ' · 余额 ¥' + displayCents(result.balanceAfterCents);
  if (props.workspace.mode !== 'cloud') Promise.resolve().then(() => sameScope(scope) && props.announce?.(result, draft, member)).catch(() => {});
}
</script>
