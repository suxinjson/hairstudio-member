<template>
  <section class="book-stack" aria-label="会员档案">
    <!-- 顶部搜索与操作栏 -->
    <form class="book-panel book-actions" role="search" @submit.prevent="search" style="padding: 0.875rem 1rem;">
      <div class="book-inline book-between" style="width: 100%; gap: 0.5rem; align-items: flex-end;">
        <label style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.35rem; font-weight: 700; font-size: 0.875rem; color: #1e293b;">
          <span>搜索会员</span>
          <div style="position: relative; width: 100%;">
            <input v-model.trim="query" maxlength="128" placeholder="姓名、电话或备注"
              style="width: 100%; height: 2.75rem; padding-left: 2.25rem; border-radius: 0.75rem; background: #f8fafc; border: 1px solid #cbd5e1;">
            <Search :size="17" aria-hidden="true" style="position: absolute; left: 0.75rem; top: 50%; transform: translateY(-50%); color: #94a3b8; pointer-events: none;" />
            <button v-if="query" type="button" @click="query = ''; search()" aria-label="清空搜索"
              style="position: absolute; right: 0.5rem; top: 50%; transform: translateY(-50%); border: none; background: transparent; padding: 0.25rem; min-height: unset; color: #94a3b8; cursor: pointer;">✕</button>
          </div>
        </label>
        <div class="book-actions" style="margin: 0; align-items: center; gap: 0.5rem; margin-bottom: 1px;">
          <button type="submit" :disabled="!workspace.state.book" aria-label="查询" class="book-btn" style="min-height: 2.75rem;">查询</button>
          <button v-if="canEdit" type="button" class="book-primary" :disabled="blocked" aria-label="新增会员" @click="create" style="min-height: 2.75rem;">
            <UserPlus :size="17" aria-hidden="true" />
            <span>新增会员</span>
          </button>
        </div>
      </div>

      <!-- 快捷筛选胶囊栏 + 保留原生 select -->
      <div class="book-inline book-between" style="gap: 0.5rem; padding-top: 0.25rem;">
        <div class="filter-tabs-row" role="tablist" aria-label="会员范围筛选">
          <button v-for="item in filterOptions" :key="item.value" type="button" role="tab"
            class="filter-tab-pill" :class="{ active: balance === item.value }"
            :aria-selected="balance === item.value" @click="balance = item.value; search()">
            {{ item.label }}
          </button>
        </div>
        <!-- 保持对测试中 select 查询的完全兼容 -->
        <label style="display: none;">会员范围<select v-model="balance" @change="search"><option v-for="opt in filterOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option></select></label>
      </div>
    </form>

    <p v-if="error" class="book-panel book-alert" role="alert">{{ error }}</p>
    <p v-if="receipt" class="book-panel" style="background: #f0fdf4; border-color: #bbf7d0; color: #166534;" role="status">{{ receipt }}</p>

    <!-- 会员编辑 / 新增抽屉 -->
    <div v-if="editor" class="app-sheet-backdrop" @click.self="editor = null">
      <form class="book-panel book-stack app-sheet-surface" @submit.prevent="saveProfile">
        <div class="book-actions book-between" style="margin-bottom: 0.25rem;">
          <h3 style="margin: 0; font-size: 1.15rem;">{{ editor.memberId ? '编辑档案' : '新增会员 · 初始余额为零' }}</h3>
          <button type="button" class="book-btn" :disabled="workspace.state.busy || savingProfile" @click="editor = null" aria-label="关闭" style="min-height: 2.25rem; padding: 0.25rem 0.625rem;">✕</button>
        </div>
        <div class="book-fields">
          <label>姓名<input v-model.trim="editor.name" required maxlength="128" placeholder="会员姓名"></label>
          <label>电话<input v-model.trim="editor.phone" type="tel" maxlength="64" placeholder="手机号码（选填）"></label>
          <label>标签（以 | 分隔）<input v-model.trim="editor.tags" maxlength="1024" placeholder="例如：常剪发 | 熟客"></label>
        </div>
        <label>备注<textarea v-model.trim="editor.notes" rows="2" maxlength="1000" placeholder="发型偏好、染膏色号或特别要求"></textarea></label>
        <div v-if="duplicate" class="book-alert" role="alert">
          <p><strong>有其他同名的在用会员。</strong>本次未留手机号，请先核对是否为同一人。</p>
          <ul style="margin: 0.25rem 0; padding-left: 1.25rem;">
            <li v-for="match in duplicate.matches.slice(0, 3)" :key="match.id">
              {{ match.name }} · {{ match.phone ? '尾号 ' + match.phone.slice(-4) : '未留手机号' }}{{ match.notes ? ' · ' + match.notes.slice(0, 60) : '' }}
            </li>
          </ul>
          <p style="font-size: 0.8125rem; color: #78350f;">{{ MEMBER_IDENTITY_ADVICE }}</p>
        </div>
        <div class="book-actions" style="margin-top: 0.5rem;">
          <button class="book-primary" type="submit" :disabled="blocked" :aria-label="duplicate ? '仍然保存' : '保存档案'" style="flex: 1;">
            {{ duplicate ? '仍然保存' : '保存档案' }}
          </button>
          <button v-if="duplicate" type="button" :disabled="blocked" aria-label="返回补充" @click="duplicate = null">返回补充</button>
          <button type="button" :disabled="workspace.state.busy || savingProfile" aria-label="关闭" @click="editor = null">关闭</button>
        </div>
      </form>
    </div>

    <!-- 扣款 / 充值 / 冲正交易弹窗 -->
    <RelationalSale v-if="sale" ref="saleForm" :key="sale.key" v-bind="sale" :workspace="workspace" @close="sale = null" @done="settled" />

    <!-- 会员详情抽屉 (Bottom Sheet) -->
    <div v-if="detail" class="app-sheet-backdrop" @click.self="closeDetail">
      <article class="book-panel book-stack app-sheet-surface" style="padding-top: 1.25rem;">
        <div class="book-actions book-between" style="border-bottom: 1px solid #f1f5f9; padding-bottom: 0.75rem;">
          <div style="display: flex; align-items: center; gap: 0.75rem;">
            <div class="customer-avatar" aria-hidden="true" style="width: 48px; height: 48px; font-size: 1.25rem;">{{ detail.name.charAt(0) }}</div>
            <div>
              <h3 style="margin: 0; font-size: 1.2rem; font-weight: 800; color: #1e293b;">{{ detail.name }}</h3>
              <p style="margin: 0.15rem 0 0; font-size: 0.875rem; color: #64748b;">
                {{ detail.phone ? formatPhone(detail.phone) : '未留手机号' }} · {{ detail.archivedAt ? '已归档' : '在用会员' }}
              </p>
            </div>
          </div>
          <button type="button" aria-label="收起档案" class="book-btn" @click="closeDetail" style="min-height: 2.25rem; padding: 0.25rem 0.75rem; border-radius: 0.625rem;">收起档案</button>
        </div>

        <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.875rem 1rem; background: #f8fafc; border-radius: 0.875rem; border: 1px solid #e2e8f0;">
          <div>
            <span style="font-size: 0.8125rem; color: #64748b; display: block;">{{ BigInt(detail.balanceCents) < 0n ? '当前欠款' : '可用储值余额' }}</span>
            <strong :style="{ color: BigInt(detail.balanceCents) < 0n ? '#e11d48' : '#167c68', fontSize: '1.5rem', fontWeight: '850' }">
              ¥{{ displayCents(detail.balanceCents) }}
            </strong>
          </div>
          <button v-if="feature('cashier')" type="button" aria-label="查看会员流水" class="book-btn" @click="$emit('history', detail.id, detail.name)" style="min-height: 2.5rem; font-size: 0.875rem;">
            <Receipt :size="16" aria-hidden="true" />
            <span>查看流水</span>
          </button>
        </div>

        <div v-if="detail.tags && detail.tags.length" style="display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center;">
          <span style="font-size: 0.8125rem; color: #64748b;">标签：</span>
          <span v-for="tag in detail.tags" :key="tag" style="background: #e6f4f1; color: #167c68; padding: 0.15rem 0.5rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">{{ tag }}</span>
        </div>

        <div v-if="detail.notes" class="book-break" style="padding: 0.75rem; background: #fffbeb; border-radius: 0.75rem; border: 1px solid #fef3c7; color: #92400e; font-size: 0.875rem;">
          <strong>会员备注：</strong>{{ detail.notes }}
        </div>

        <div v-if="!detail.archivedAt" class="book-actions" style="margin-top: 0.5rem; gap: 0.5rem;">
          <button v-if="canCashier" class="book-primary" type="button" :disabled="blocked" aria-label="消费" @click="openSale('consume')" style="flex: 1; min-height: 2.875rem; font-size: 1rem;">
            <Scissors :size="18" aria-hidden="true" />
            <span>消费扣款</span>
          </button>
          <button v-if="canCashier" class="book-btn" type="button" :disabled="blocked" aria-label="充值" @click="openSale('recharge')"
            style="flex: 1; min-height: 2.875rem; font-size: 1rem; background: #f0fdf4; border-color: #bbf7d0; color: #166534; font-weight: 700;">
            <CreditCard :size="18" aria-hidden="true" />
            <span>会员充值</span>
          </button>
          <button v-if="canEdit" type="button" class="book-btn" :disabled="blocked" aria-label="编辑" @click="edit" style="min-height: 2.875rem;">编辑</button>
          <button v-if="owner && canEdit && detail.balanceCents === '0'" type="button" class="book-btn" :disabled="blocked" aria-label="归档" @click="archive" style="min-height: 2.875rem; color: #64748b;">归档</button>
        </div>
      </article>
    </div>

    <!-- 会员列表状态展示 -->
    <p v-if="page.error.value" class="book-panel book-alert" role="alert">{{ page.error.value }}</p>
    <div v-else-if="page.busy.value" class="book-panel book-stack" style="text-align: center; padding: 2rem 1rem;" role="status">
      <div style="font-size: 1.5rem; animation: spin 1s linear infinite; display: inline-block;">⏳</div>
      <p style="margin: 0.5rem 0 0; color: #64748b;">正在查询会员档案…</p>
    </div>
    <div v-else class="book-panel book-stack" style="padding: 0.875rem 1rem;">
      <p v-if="!page.rows.value.length" style="text-align: center; color: #64748b; padding: 2rem 0; margin: 0;">没有符合条件的会员。</p>
      
      <!-- 现代化会员卡片列表 -->
      <ul v-else class="book-list" style="gap: 0.625rem;">
        <li v-for="member in page.rows.value" :key="member.id" class="customer-card" :class="{ 'customer-card-debt': BigInt(member.balanceCents) < 0n }">
          <div class="customer-info-area" @click="select(member.id)">
            <div class="customer-avatar" aria-hidden="true">{{ member.name.charAt(0) }}</div>
            <div class="customer-meta">
              <div class="customer-name-row">
                <!-- 保持对测试中 ui.button(member.name).click() 的精确匹配 -->
                <button type="button" class="book-link customer-name-text" :aria-label="member.name" @click.stop="select(member.id)">
                  {{ member.name }}
                </button>
                <span v-if="member.phone" class="customer-phone-text">{{ formatPhone(member.phone) }}</span>
              </div>
              <span v-if="member.notes" class="customer-note-snippet" :title="member.notes">{{ member.notes }}</span>
            </div>
          </div>

          <div class="customer-balance-box">
            <strong class="customer-balance-badge" :class="{ 'customer-balance-debt': BigInt(member.balanceCents) < 0n }">
              ¥{{ displayCents(member.balanceCents) }}
            </strong>
            <div class="customer-card-actions">
              <button v-if="canCashier" type="button" class="book-primary" :disabled="blocked" aria-label="扣款" @click="quickSale(member, 'consume')">扣款</button>
              <button v-if="canCashier" type="button" class="book-btn" :disabled="blocked" aria-label="充值" @click="quickSale(member, 'recharge')"
                style="background: #f0fdf4; border-color: #bbf7d0; color: #166534; font-weight: 700;">充值</button>
            </div>
          </div>
        </li>
      </ul>

      <!-- 分页控制 -->
      <div class="book-actions book-between" style="border-top: 1px solid #f1f5f9; padding-top: 0.75rem; margin-top: 0.25rem;">
        <div class="book-actions" style="margin: 0; gap: 0.5rem;">
          <button v-if="page.cursor.value" type="button" class="book-btn" aria-label="回到第一页" @click="page.load()">回到第一页</button>
          <button v-if="page.next.value" type="button" class="book-btn" aria-label="下一页" @click="page.load(page.next.value)">下一页</button>
        </div>
        <span class="book-muted">本页 {{ page.rows.value.length }} 条</span>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { Search, UserPlus, Scissors, CreditCard, Receipt } from 'lucide-vue-next';
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
  { value: 'all', label: '在用会员' },
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
