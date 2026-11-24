<template>
  <section class="book-stack" aria-label="会员档案">
    <form class="book-panel book-actions" role="search" @submit.prevent="search">
      <label>搜索会员<input v-model.trim="query" maxlength="128" placeholder="姓名、电话或备注"></label>
      <label>会员范围<select v-model="balance" @change="search"><option value="all">在用会员</option><option value="recent">最近来店</option><option value="positive">有储值</option><option value="low">余额 0–50 元</option><option value="debt">欠款</option><option value="archived">已归档</option></select></label>
      <button type="submit" :disabled="!workspace.state.book">查询</button>
      <button v-if="canEdit" type="button" class="book-primary" :disabled="blocked" @click="create">新增会员</button>
    </form>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="receipt" role="status">{{ receipt }}</p>
    <form v-if="editor" class="book-panel book-stack" @submit.prevent="saveProfile">
      <h3>{{ editor.memberId ? '编辑档案' : '新增会员 · 初始余额为零' }}</h3>
      <div class="book-fields">
        <label>姓名<input v-model.trim="editor.name" required maxlength="128"></label>
        <label>电话<input v-model.trim="editor.phone" type="tel" maxlength="64"></label>
        <label>标签（以 | 分隔）<input v-model.trim="editor.tags" maxlength="1024"></label>
      </div>
      <label>备注<textarea v-model.trim="editor.notes" rows="2" maxlength="1000"></textarea></label>
      <div v-if="duplicate" class="book-alert" role="alert">
        <p>有其他同名的在用会员。本次未留手机号，请先核对是否为同一人。</p>
        <ul><li v-for="match in duplicate.matches.slice(0, 3)" :key="match.id">{{ match.name }} · {{ match.phone ? '尾号 ' + match.phone.slice(-4) : '未留手机号' }}{{ match.notes ? ' · ' + match.notes.slice(0, 60) : '' }}</li></ul>
        <p>{{ MEMBER_IDENTITY_ADVICE }}</p>
      </div>
      <div class="book-actions">
        <button class="book-primary" type="submit" :disabled="blocked">{{ duplicate ? '仍然保存' : '保存档案' }}</button>
        <button v-if="duplicate" type="button" :disabled="blocked" @click="duplicate = null">返回补充</button>
        <button type="button" :disabled="workspace.state.busy || savingProfile" @click="editor = null">关闭</button>
      </div>
    </form>
    <RelationalSale v-if="sale" ref="saleForm" :key="sale.key" v-bind="sale" :workspace="workspace" @close="sale = null" @done="settled" />
    <article v-if="detail" class="book-panel book-stack">
      <div class="book-actions book-between"><h3>{{ detail.name }}</h3><button type="button" @click="closeDetail">收起档案</button></div>
      <p>余额 ¥{{ displayCents(detail.balanceCents) }} · {{ detail.archivedAt ? '已归档' : '在用' }}</p>
      <p v-if="detail.phone">电话 {{ detail.phone }}</p>
      <p v-if="detail.tags.length">标签：{{ detail.tags.join('、') }}</p>
      <p v-if="detail.notes" class="book-break">备注：{{ detail.notes }}</p>
      <div class="book-actions">
        <button v-if="feature('cashier')" type="button" @click="$emit('history', detail.id, detail.name)">查看会员流水</button>
        <template v-if="!detail.archivedAt">
          <button v-if="canCashier" class="book-primary" type="button" :disabled="blocked" @click="openSale('consume')">消费</button>
          <button v-if="canCashier" type="button" :disabled="blocked" @click="openSale('recharge')">充值</button>
          <button v-if="canEdit" type="button" :disabled="blocked" @click="edit">编辑</button>
          <button v-if="owner && canEdit && detail.balanceCents === '0'" type="button" :disabled="blocked" @click="archive">归档</button>
        </template>
      </div>
    </article>
    <p v-if="page.error.value" role="alert">{{ page.error.value }}</p>
    <p v-else-if="page.busy.value" role="status">正在查询会员…</p>
    <div v-else class="book-panel book-stack">
      <p v-if="!page.rows.value.length">没有符合条件的会员。</p>
      <ul v-else class="book-list">
        <li v-for="member in page.rows.value" :key="member.id">
          <button type="button" class="book-link" @click="select(member.id)">{{ member.name }}</button>
          <span v-if="member.phone" class="book-muted">尾号 {{ member.phone.slice(-4) }}</span>
          <span v-if="member.notes" class="book-muted book-break">{{ member.notes.slice(0, 72) }}</span>
          <strong>¥{{ displayCents(member.balanceCents) }}</strong>
        </li>
      </ul>
      <div class="book-actions">
        <button v-if="page.cursor.value" type="button" @click="page.load()">回到第一页</button>
        <button v-if="page.next.value" type="button" @click="page.load(page.next.value)">下一页</button>
        <span class="book-muted">本页 {{ page.rows.value.length }} 条</span>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import RelationalSale from './RelationalSale.vue';
import { useRelationalPage } from '../composables/useRelationalPage.js';
import { displayCents } from '../relational-presentation.js';
import { canonicalJSON } from '../canonical-json.js';
import { MEMBER_IDENTITY_ADVICE, memberIdentitySignature } from '../member-identity.js';

const props = defineProps({ workspace: Object, owner: Boolean, writable: Boolean, cashierWritable: { type: Boolean, default: undefined }, feature: Function, announce: Function,
  balanceFilter: { type: String, default: 'all' } });
defineEmits(['history']);
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
