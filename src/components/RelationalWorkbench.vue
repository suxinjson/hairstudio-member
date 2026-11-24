<template>
  <nav class="book-panel book-actions book-nav-bar" aria-label="收银菜单">
    <button v-for="item in pages" :key="item.id" type="button" :aria-label="item.label" :aria-current="active === item.id ? 'page' : undefined"
      :class="{ 'book-primary': active === item.id }" @click="active = item.id">
      <component :is="item.icon" :size="18" aria-hidden="true" />
      <span>{{ item.label }}</span>
    </button>
  </nav>
  <main class="book-stack" :key="bookKey">
    <RelationalPending v-if="workspace.state.book" :workspace="workspace" />
    <slot name="connection" />
    <div v-if="active !== 'account' && !workspace.state.book" class="book-panel book-stack">
      <p :role="workspace.state.error ? 'alert' : 'status'">{{ workspace.state.error || '正在打开账本…' }}</p>
      <button v-if="workspace.state.status !== 'loading'" type="button" @click="workspace.connect()">重试连接</button>
    </div>
    <RelationalMembers v-else-if="active === 'members'" ref="memberPage" :workspace="workspace" :owner="owner" :writable="profileWritable"
      :cashier-writable="writable" :feature="feature" :announce="announce" :balance-filter="memberFilter" @history="openHistory" />
    <RelationalLedger v-else-if="active === 'ledger'" ref="ledgerPage" :workspace="workspace" :owner="owner && writable" :member-id="history.id"
      :member-name="history.name" @all-members="history = {}" />
    <RelationalReports v-else-if="active === 'reports'" :workspace="workspace" />
    <RelationalConfiguration v-else-if="active === 'configuration'" :workspace="workspace" :owner="owner && profileWritable" />
    <RelationalBatches v-else-if="active === 'batches'" :workspace="workspace" :writable="profileWritable" />
    <RelationalBackup v-else-if="active === 'backup'" :workspace="workspace" :controller="backup" />
    <slot v-else />
  </main>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { Users, Receipt, BarChart3, Tag, Files, HardDrive, Settings } from 'lucide-vue-next';
import RelationalMembers from './RelationalMembers.vue';
import RelationalLedger from './RelationalLedger.vue';
import RelationalReports from './RelationalReports.vue';
import RelationalConfiguration from './RelationalConfiguration.vue';
import RelationalPending from './RelationalPending.vue';
import RelationalBatches from './RelationalBatches.vue';
import RelationalBackup from './RelationalBackup.vue';

const props = defineProps({ workspace: { type: Object, required: true }, owner: Boolean, profileWritable: Boolean,
  writable: Boolean, feature: { type: Function, required: true }, announce: Function, backup: Object, identity: String });
const pages = computed(() => [
  { id: 'members', label: '会员收银', icon: Users, feature: 'members' },
  { id: 'ledger', label: '财务流水', icon: Receipt, feature: 'cashier' },
  { id: 'reports', label: '经营报表', icon: BarChart3, feature: 'reports' },
  { id: 'configuration', label: '服务与价格', icon: Tag, feature: 'settings' },
  ...(props.workspace.batch ? [{ id: 'batches', label: '批量资料', icon: Files, feature: 'members' }] : []),
  ...(props.owner && props.backup ? [{ id: 'backup', label: '备份与恢复', icon: HardDrive, feature: 'backup' }] : []),
  { id: 'account', label: '账号与设置', icon: Settings }
].filter(item => !item.feature || props.feature(item.feature)));
const active = ref(pages.value[0].id), history = ref({}), memberFilter = ref('all');
const memberPage = ref(null), ledgerPage = ref(null);
const hasOpenAction = computed(() => Boolean(memberPage.value?.hasOpenAction || ledgerPage.value?.hasOpenAction));
const bookKey = computed(() => JSON.stringify([props.identity, props.workspace.state.book?.ledgerEpoch]));
watch(() => props.identity, () => { active.value = pages.value[0].id; memberFilter.value = 'all'; });
watch(bookKey, () => { history.value = {}; });
watch(pages, items => { if (!items.some(item => item.id === active.value)) active.value = items[0].id; });
function openHistory(id, name) { history.value = { id, name }; active.value = 'ledger'; }
function openPage(id) { if (pages.value.some(item => item.id === id)) { active.value = id; return true; } return false; }
defineExpose({ hasOpenAction, openAccount: () => openPage('account'), openBackup: () => openPage('backup'), openMembers: filter => {
  if (openPage('members')) memberFilter.value = filter;
}, goHome: () => {
  if (props.workspace.state.busy || memberPage.value?.goBack() || ledgerPage.value?.goBack()) return true;
  if (active.value === 'ledger' && history.value.id) { history.value = {}; active.value = 'members'; return true; }
  if (active.value === pages.value[0].id) return false;
  active.value = pages.value[0].id; history.value = {}; memberFilter.value = 'all'; return true;
} });
</script>
